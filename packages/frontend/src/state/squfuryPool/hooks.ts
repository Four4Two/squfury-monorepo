import { DEFAULT_SLIPPAGE, OSQUFURY_DECIMALS, UNI_POOL_FEES, WETH_DECIMALS, ZERO_ADDRESS } from '@constants/index'
import useAppCallback from '@hooks/useAppCallback'
import useAppEffect from '@hooks/useAppEffect'
import { useETHPrice } from '@hooks/useETHPrice'
import { useOracle } from '@hooks/contracts/useOracle'
import useUniswapTicks from '@hooks/useUniswapTicks'
import { CurrencyAmount, Percent, Token, TradeType } from '@uniswap/sdk-core'
import { AlphaRouter, ChainId, SwapRoute } from '@uniswap/smart-order-router'
import { Pool, Route, Trade } from '@uniswap/v3-sdk'
import { fromTokenAmount, parseSlippageInput } from '@utils/calculations'
import BigNumber from 'bignumber.js'
import { ethers } from 'ethers'
import { useAtomValue } from 'jotai'
import { useUpdateAtom } from 'jotai/utils'
import { Contract } from 'web3-eth-contract'
import routerABI from '../../abis/swapRouter.json'
import router2ABI from '../../abis/swapRouter2.json'
import { squfuryPoolContractAtom, swapRouter2ContractAtom, swapRouterContractAtom } from '../contracts/atoms'
import { addressesAtom, isWethToken0Atom } from '../positions/atoms'
import { addressAtom, networkIdAtom, web3Atom } from '../wallet/atoms'
import { useHandleTransaction } from '../wallet/hooks'
import wethAbi from '../../abis/weth.json'
import { Pair } from '@uniswap/v2-sdk'

import {
  poolAtom,
  readyAtom,
  squfuryInitialPriceAtom,
  squfuryInitialPriceErrorAtom,
  squfuryTokenAtom,
  wethTokenAtom,
} from './atoms'
import { computeRealizedLPFeePercent } from './price'
import { slippageAmountAtom } from '../trade/atoms'
import { getErrorMessage } from '@utils/error'
import useInterval from '@hooks/useInterval'
import { getGasPriceProvider } from '@utils/gasProvider'

const getImmutables = async (squfuryContract: Contract) => {
  const [token0, token1, fee, tickSpacing, maxLiquidityPerTick] = await Promise.all([
    squfuryContract?.methods.token0().call(),
    squfuryContract?.methods.token1().call(),
    squfuryContract?.methods.fee().call(),
    squfuryContract?.methods.tickSpacing().call(),
    squfuryContract?.methods.maxLiquidityPerTick().call(),
  ])

  return { token0, token1, fee, tickSpacing, maxLiquidityPerTick }
}

export const getPoolState = async (poolContract: Contract) => {
  const [slot, liquidity, tickSpacing] = await Promise.all([
    poolContract?.methods.slot0().call(),
    poolContract?.methods.liquidity().call(),
    poolContract.methods.tickSpacing().call(),
  ])

  const PoolState = {
    liquidity,
    sqrtPriceX96: slot[0],
    tick: slot[1],
    observationIndex: slot[2],
    observationCardinality: slot[3],
    observationCardinalityNext: slot[4],
    feeProtocol: slot[5],
    unlocked: slot[6],
    tickSpacing,
  }

  return PoolState
}

export const useUpdateSquFuryPoolData = () => {
  const isWethToken0 = useAtomValue(isWethToken0Atom)
  const networkId = useAtomValue(networkIdAtom)
  const setPool = useUpdateAtom(poolAtom)
  const setWethToken = useUpdateAtom(wethTokenAtom)
  const setSquFuryToken = useUpdateAtom(squfuryTokenAtom)
  const contract = useAtomValue(squfuryPoolContractAtom)
  const { ticks } = useUniswapTicks()
  useAppEffect(() => {
    let isMounted = true

    ;(async () => {
      const { token0, token1, fee } = await getImmutables(contract!)

      const state = await getPoolState(contract!)
      const TokenA = new Token(
        networkId,
        token0,
        isWethToken0 ? 18 : OSQUFURY_DECIMALS,
        isWethToken0 ? 'WETH' : 'SQE',
        isWethToken0 ? 'Wrapped Ether' : 'oSquFury',
      )
      const TokenB = new Token(
        networkId,
        token1,
        isWethToken0 ? OSQUFURY_DECIMALS : 18,
        isWethToken0 ? 'SQE' : 'WETH',
        isWethToken0 ? 'oSquFury' : 'Wrapped Ether',
      )

      const pool = new Pool(
        TokenA,
        TokenB,
        Number(fee),
        state.sqrtPriceX96.toString(),
        state.liquidity.toString(),
        Number(state.tick),
        ticks || [],
      )

      if (isMounted && ticks?.length) {
        console.log('Pools is set with tick length', ticks?.length)
        setPool(pool)
      }

      setWethToken(isWethToken0 ? TokenA : TokenB)
      setSquFuryToken(isWethToken0 ? TokenB : TokenA)
    })()

    return () => {
      isMounted = false
    }
  }, [isWethToken0, networkId, ticks?.length, contract, setPool, setWethToken, setSquFuryToken])
}

export const useSetTokens = () => {
  const networkId = useAtomValue(networkIdAtom)
  const setWethToken = useUpdateAtom(wethTokenAtom)
  const setSquFuryToken = useUpdateAtom(squfuryTokenAtom)
  const { weth, oSquFury } = useAtomValue(addressesAtom)
  const setTokens = useAppEffect(() => {
    ;(async () => {
      const wethToken = new Token(networkId, weth, WETH_DECIMALS, 'WETH', 'Wrapped Ether')
      const squfuryToken = new Token(networkId, oSquFury, OSQUFURY_DECIMALS, 'SQE', 'oSquFury')

      setWethToken(wethToken)
      setSquFuryToken(squfuryToken)
    })()
  })
  return setTokens
}

export const useGetBuyQuoteForETH = () => {
  const pool = useAtomValue(poolAtom)
  const networkId = useAtomValue(networkIdAtom)
  const web3 = useAtomValue(web3Atom)
  const address = useAtomValue(addressAtom)
  const wethToken = useAtomValue(wethTokenAtom)
  const squfuryToken = useAtomValue(squfuryTokenAtom)

  //If I input an exact amount of ETH I want to spend, tells me how much SquFury I'd purchase
  const getBuyQuoteForETH = useAppCallback(
    async (ETHAmount: BigNumber, slippageAmount = new BigNumber(DEFAULT_SLIPPAGE)) => {
      const emptyState = {
        amountOut: new BigNumber(0),
        minimumAmountOut: new BigNumber(0),
        priceImpact: '0',
        pools: [],
      }

      try {
        const slippageTolerance = slippageAmount ? slippageAmount : DEFAULT_SLIPPAGE
        const provider = new ethers.providers.Web3Provider(web3.currentProvider as any)
        const chainId = networkId as any as ChainId

        const gasPriceProvider = getGasPriceProvider(chainId)

        const router = new AlphaRouter({
          chainId: chainId,
          provider: provider as any,
          gasPriceProvider,
        })

        const rawAmount = CurrencyAmount.fromRawAmount(wethToken!, fromTokenAmount(ETHAmount, 18).toFixed(0))

        const route = await router.route(rawAmount, squfuryToken!, TradeType.EXACT_INPUT, {
          recipient: address ?? ZERO_ADDRESS,
          slippageTolerance: parseSlippageInput(slippageTolerance.toString()),
          deadline: Math.floor(Date.now() / 1000 + 1800),
        })

        if (!route) return null

        const realizedLpFeePercent = computeRealizedLPFeePercent(route!.trade)
        const priceImpact = route!.trade.priceImpact.subtract(realizedLpFeePercent).multiply(-1)

        return {
          amountOut: new BigNumber(route!.quote.toSignificant(OSQUFURY_DECIMALS)),
          minimumAmountOut: new BigNumber(
            route!.trade
              .minimumAmountOut(parseSlippageInput(slippageAmount.toString()))
              .toSignificant(OSQUFURY_DECIMALS),
          ),
          priceImpact: priceImpact.toFixed(2),
          pools: getPoolInfo(route, ETHAmount),
        }
      } catch (e) {
        console.log(e)
      }
      return emptyState
    },
    [pool, wethToken?.address, squfuryToken?.address, web3, networkId, address],
  )

  return getBuyQuoteForETH
}

export const useUpdateSquFuryPrices = () => {
  const { getTwapSafe } = useOracle()

  const setSquFuryInitialPrice = useUpdateAtom(squfuryInitialPriceAtom)
  const setSquFuryInitialPriceError = useUpdateAtom(squfuryInitialPriceErrorAtom)
  const setReady = useUpdateAtom(readyAtom)
  const { oSquFury, weth, squfuryPool } = useAtomValue(addressesAtom)

  const getTwapSquFury = () => {
    if (squfuryPool && oSquFury && weth)
      getTwapSafe(squfuryPool, oSquFury, weth, 1)
        .then((quote) => setSquFuryInitialPrice(quote))
        .catch((error) => {
          console.error(error)
          setSquFuryInitialPriceError(getErrorMessage(error))
        })
        .finally(() => {
          setReady(true)
        })
  }

  useInterval(getTwapSquFury, 15000)

  useAppEffect(() => {
    getTwapSquFury()
  }, [getTwapSafe, oSquFury, weth, setReady, setSquFuryInitialPrice, setSquFuryInitialPriceError, squfuryPool])
}

export const useGetWSquFuryPositionValue = () => {
  const ethPrice = useETHPrice()
  const squfuryInitialPrice = useAtomValue(squfuryInitialPriceAtom)
  const getWSquFuryPositionValue = useAppCallback(
    (amount: BigNumber | number) => {
      return new BigNumber(amount).times(squfuryInitialPrice).times(ethPrice)
    },
    [ethPrice, squfuryInitialPrice],
  )

  return getWSquFuryPositionValue
}

export const useGetWSquFuryPositionValueInETH = () => {
  const squfuryInitialPrice = useAtomValue(squfuryInitialPriceAtom)
  const getWSquFuryPositionValueInETH = useAppCallback(
    (amount: BigNumber | number) => {
      return new BigNumber(amount).times(squfuryInitialPrice)
    },
    [squfuryInitialPrice],
  )
  return getWSquFuryPositionValueInETH
}

export const useGetBuyQuote = () => {
  const pool = useAtomValue(poolAtom)
  const wethToken = useAtomValue(wethTokenAtom)
  const squfuryToken = useAtomValue(squfuryTokenAtom)
  //If I input an exact amount of squfury I want to buy, tells me how much ETH I need to pay to purchase that squfury
  const getBuyQuote = useAppCallback(
    async (squfuryAmount: BigNumber, slippageAmount = new BigNumber(DEFAULT_SLIPPAGE)) => {
      const emptyState = {
        amountIn: new BigNumber(0),
        maximumAmountIn: new BigNumber(0),
        priceImpact: '0',
        poolFee: '0',
      }

      if (!squfuryAmount || !pool) return emptyState

      try {
        //WETH is input token, squfury is output token. I'm using WETH to buy SquFury
        const route = new Route([pool], wethToken!, squfuryToken!)
        //getting the amount of ETH I need to put in to get an exact amount of squfury I inputted out
        const rawAmount = CurrencyAmount.fromRawAmount(
          squfuryToken!,
          fromTokenAmount(squfuryAmount, OSQUFURY_DECIMALS).toFixed(0),
        )

        if (rawAmount.equalTo(0)) {
          return emptyState
        }

        const trade = await Trade.exactOut(route, rawAmount)
        const feePercent = new BigNumber(pool.fee).div(10000)

        //the amount of ETH I need to put in
        return {
          amountIn: new BigNumber(trade.inputAmount.toSignificant(18)),
          maximumAmountIn: new BigNumber(
            trade.maximumAmountIn(parseSlippageInput(slippageAmount.toString())).toSignificant(18),
          ),
          priceImpact: trade.priceImpact.toFixed(2),
          poolFee: feePercent.toFixed(2),
        }
      } catch (e) {
        console.log(e)
      }

      return emptyState
    },
    [pool, wethToken?.address, squfuryToken?.address],
  )

  return getBuyQuote
}

export const useGetBuyParam = () => {
  const address = useAtomValue(addressAtom)
  const squfuryToken = useAtomValue(squfuryTokenAtom)
  const wethToken = useAtomValue(wethTokenAtom)
  const getBuyQuote = useGetBuyQuote()
  const getBuyParam = async (amount: BigNumber) => {
    const amountMax = fromTokenAmount((await getBuyQuote(amount)).maximumAmountIn, 18)

    return {
      tokenIn: wethToken?.address, // address
      tokenOut: squfuryToken?.address, // address
      fee: UNI_POOL_FEES, // uint24
      recipient: address, // address
      deadline: Math.floor(Date.now() / 1000 + 86400), // uint256
      amountOut: fromTokenAmount(amount, OSQUFURY_DECIMALS).toString(), // uint256
      amountInMaximum: amountMax.toString(),
      sqrtPriceLimitX96: 0, // uint160
    }
  }

  return getBuyParam
}

export const useBuy = () => {
  const address = useAtomValue(addressAtom)
  const swapRouterContract = useAtomValue(swapRouterContractAtom)
  const handleTransaction = useHandleTransaction()
  const getBuyParam = useGetBuyParam()
  const buy = async (amount: BigNumber) => {
    const exactOutputParam = await getBuyParam(amount)

    await handleTransaction(
      swapRouterContract?.methods.exactOutputSingle(exactOutputParam).send({
        from: address,
      }),
    )
  }
  return buy
}

export const useGetBuyParamForETH = () => {
  const address = useAtomValue(addressAtom)
  const squfuryToken = useAtomValue(squfuryTokenAtom)
  const wethToken = useAtomValue(wethTokenAtom)
  const getBuyQuoteForETH = useGetBuyQuoteForETH()
  const getBuyParamForETH = async (amount: BigNumber) => {
    const quote = await getBuyQuoteForETH(amount)

    return {
      tokenIn: wethToken?.address,
      tokenOut: squfuryToken?.address,
      fee: UNI_POOL_FEES,
      recipient: address,
      deadline: Math.floor(Date.now() / 1000 + 86400), // uint256
      amountIn: fromTokenAmount(amount, 18),
      amountOutMinimum: fromTokenAmount(quote!.minimumAmountOut, OSQUFURY_DECIMALS).toString(),
      sqrtPriceLimitX96: 0,
    }
  }

  return getBuyParamForETH
}

export const useBuyForWETH = () => {
  const address = useAtomValue(addressAtom)
  const handleTransaction = useHandleTransaction()
  const swapRouterContract = useAtomValue(swapRouterContractAtom)
  const getBuyParamForETH = useGetBuyParamForETH()
  const buyForWETH = async (amount: BigNumber) => {
    const exactInputParam = await getBuyParamForETH(new BigNumber(amount))

    const txHash = await handleTransaction(
      swapRouterContract?.methods.exactInputSingle(exactInputParam).send({
        from: address,
        value: fromTokenAmount(amount, 18),
      }),
    )

    return txHash
  }

  return buyForWETH
}

export const useBuyAndRefundData = () => {
  const address = useAtomValue(addressAtom)
  const web3 = useAtomValue(web3Atom)
  const getBuyParamForETH = useGetBuyParamForETH()
  const buyAndRefundData = async (amount: BigNumber) => {
    if (!web3) return
    const exactInputParam = await getBuyParamForETH(amount)
    exactInputParam.recipient = address
    const tupleInput = Object.values(exactInputParam).map((v) => v?.toString() || '')

    const swapIface = new ethers.utils.Interface(routerABI)
    const encodedSwapCall = swapIface.encodeFunctionData('exactInputSingle', [tupleInput])
    const encodedRefundCall = swapIface.encodeFunctionData('refundETH')

    return [encodedSwapCall, encodedRefundCall]
  }

  return buyAndRefundData
}

export const useBuyAndRefund = () => {
  const address = useAtomValue(addressAtom)
  const handleTransaction = useHandleTransaction()
  const swapRouterContract = useAtomValue(swapRouterContractAtom)
  const buyAndRefundData = useBuyAndRefundData()

  const buyAndRefund = useAppCallback(
    async (amount: BigNumber, onTxConfirmed?: () => void) => {
      const callData = await buyAndRefundData(amount)

      const result = await handleTransaction(
        swapRouterContract?.methods.multicall(callData).send({
          from: address,
          value: fromTokenAmount(amount, 18),
        }),
        onTxConfirmed,
      )

      return result
    },
    [address, swapRouterContract, buyAndRefundData],
  )

  return buyAndRefund
}

export const useAutoRoutedBuyAndRefund = () => {
  const networkId = useAtomValue(networkIdAtom)
  const address = useAtomValue(addressAtom)
  const wethToken = useAtomValue(wethTokenAtom)
  const { swapRouter2, weth } = useAtomValue(addressesAtom)
  const web3 = useAtomValue(web3Atom)
  const squfuryToken = useAtomValue(squfuryTokenAtom)
  const swapRouter2Contract = useAtomValue(swapRouter2ContractAtom)
  const slippageAmount = useAtomValue(slippageAmountAtom)
  const handleTransaction = useHandleTransaction()

  const autoRoutedBuyAndRefund = useAppCallback(
    async (amount: BigNumber, onTxConfirmed?: () => void) => {
      // Initializing the AlphaRouter
      const provider = new ethers.providers.Web3Provider(web3.currentProvider as any)
      const chainId = networkId as any as ChainId

      const gasPriceProvider = getGasPriceProvider(chainId)
      const router = new AlphaRouter({
        chainId: chainId,
        provider: provider as any,
        gasPriceProvider,
      })
      const slippageTolerance = slippageAmount ? slippageAmount : DEFAULT_SLIPPAGE

      // Call Route
      const rawAmount = CurrencyAmount.fromRawAmount(wethToken!, fromTokenAmount(amount, WETH_DECIMALS).toFixed(0))
      const route = await router.route(rawAmount, squfuryToken!, TradeType.EXACT_INPUT, {
        recipient: address!,
        slippageTolerance: parseSlippageInput(slippageTolerance.toString()),
        deadline: Math.floor(Date.now() / 1000 + 1800),
      })

      const wethContract = new web3.eth.Contract(wethAbi as any, weth)
      await wethContract.methods.approve(swapRouter2, fromTokenAmount(amount, WETH_DECIMALS).toFixed(0))

      const gasEstimate = await swapRouter2Contract?.methods
        .multicall([route?.methodParameters?.calldata])
        .estimateGas({
          to: swapRouter2,
          value: fromTokenAmount(amount, WETH_DECIMALS).toFixed(0),
          from: address,
        })

      const result = await handleTransaction(
        swapRouter2Contract?.methods.multicall([route?.methodParameters?.calldata]).send({
          to: swapRouter2,
          value: fromTokenAmount(amount, WETH_DECIMALS).toFixed(0),
          from: address,
          gas: gasEstimate,
        }),
        onTxConfirmed,
      )
      return result
    },
    [address, slippageAmount, web3, wethToken, squfuryToken],
  )

  return autoRoutedBuyAndRefund
}

export const useAutoRoutedGetSellQuote = () => {
  const pool = useAtomValue(poolAtom)
  const squfuryToken = useAtomValue(squfuryTokenAtom)
  const wethToken = useAtomValue(wethTokenAtom)
  const networkId = useAtomValue(networkIdAtom)
  const web3 = useAtomValue(web3Atom)
  const address = useAtomValue(addressAtom)

  //I input an exact amount of squfury I want to sell, tells me how much ETH I'd receive
  const getSellQuote = useAppCallback(
    async (squfuryAmount: BigNumber, slippageAmount = new BigNumber(DEFAULT_SLIPPAGE)) => {
      const emptyState = {
        amountOut: new BigNumber(0),
        minimumAmountOut: new BigNumber(0),
        priceImpact: '0',
        pools: [],
      }
      if (!squfuryAmount || squfuryAmount.eq(0)) return emptyState

      const slippageTolerance = slippageAmount ? slippageAmount : DEFAULT_SLIPPAGE
      const provider = new ethers.providers.Web3Provider(web3.currentProvider as any)
      const chainId = networkId as any as ChainId

      const gasPriceProvider = getGasPriceProvider(chainId)
      const router = new AlphaRouter({
        chainId: chainId,
        provider: provider as any,
        gasPriceProvider,
      })

      const rawAmount = CurrencyAmount.fromRawAmount(
        squfuryToken!,
        fromTokenAmount(squfuryAmount, OSQUFURY_DECIMALS).toFixed(0),
      )
      const route = await router.route(rawAmount, wethToken!, TradeType.EXACT_INPUT, {
        recipient: address ?? ZERO_ADDRESS,
        slippageTolerance: parseSlippageInput(slippageTolerance.toString()),
        deadline: Math.floor(Date.now() / 1000 + 1800),
      })

      if (!route) return null

      const realizedLpFeePercent = computeRealizedLPFeePercent(route!.trade)
      const priceImpact = route!.trade.priceImpact.subtract(realizedLpFeePercent).multiply(-1)

      try {
        return {
          amountOut: new BigNumber(route!.quote?.toSignificant(WETH_DECIMALS)),
          minimumAmountOut: new BigNumber(
            route!.trade.minimumAmountOut(parseSlippageInput(slippageAmount.toString())).toSignificant(WETH_DECIMALS),
          ),
          priceImpact: priceImpact.toFixed(2),
          pools: getPoolInfo(route, squfuryAmount),
        }
      } catch (e) {
        console.log(e)
      }

      return emptyState
    },
    [pool, wethToken?.address, squfuryToken?.address],
  )
  return getSellQuote
}

export const useGetSellQuote = () => {
  const pool = useAtomValue(poolAtom)
  const squfuryToken = useAtomValue(squfuryTokenAtom)
  const wethToken = useAtomValue(wethTokenAtom)
  //I input an exact amount of squfury I want to sell, tells me how much ETH I'd receive
  const getSellQuote = useAppCallback(
    async (squfuryAmount: BigNumber, slippageAmount = new BigNumber(DEFAULT_SLIPPAGE)) => {
      const emptyState = {
        amountOut: new BigNumber(0),
        minimumAmountOut: new BigNumber(0),
        priceImpact: '0',
        pools: [],
      }
      if (!squfuryAmount || !pool) return emptyState

      try {
        //squfury is input token, WETH is output token. I'm selling squfury for WETH
        const route = new Route([pool], squfuryToken!, wethToken!)
        //getting the amount of ETH I'd receive for inputting the amount of squfury I want to sell
        const rawAmount = CurrencyAmount.fromRawAmount(
          squfuryToken!,
          fromTokenAmount(squfuryAmount, OSQUFURY_DECIMALS).toFixed(0),
        )

        if (rawAmount.equalTo(0)) {
          return emptyState
        }

        const trade = await Trade.exactIn(route, rawAmount)
        const feePercent = new BigNumber(pool.fee).div(10000)

        //the amount of ETH I'm receiving
        return {
          amountOut: new BigNumber(trade.outputAmount.toSignificant(18)),
          minimumAmountOut: new BigNumber(
            trade.minimumAmountOut(parseSlippageInput(slippageAmount.toString())).toSignificant(18),
          ),
          priceImpact: trade.priceImpact.toFixed(2),
          poolFee: feePercent.toFixed(2),
          pools: [],
        }
      } catch (e) {
        console.log(e)
      }

      return emptyState
    },
    [pool, wethToken?.address, squfuryToken?.address],
  )
  return getSellQuote
}

export const useGetSellParam = () => {
  const address = useAtomValue(addressAtom)
  const squfuryToken = useAtomValue(squfuryTokenAtom)
  const wethToken = useAtomValue(wethTokenAtom)
  const getSellQuote = useGetSellQuote()
  const getSellParam = useAppCallback(
    async (amount: BigNumber) => {
      const amountMin = fromTokenAmount((await getSellQuote(amount))!.minimumAmountOut, 18)

      return {
        tokenIn: squfuryToken?.address,
        tokenOut: wethToken?.address,
        fee: UNI_POOL_FEES,
        recipient: address,
        deadline: Math.floor(Date.now() / 1000 + 86400), // uint256
        amountIn: fromTokenAmount(amount, OSQUFURY_DECIMALS).toString(),
        amountOutMinimum: amountMin.toString(),
        sqrtPriceLimitX96: 0,
      }
    },
    [getSellQuote, squfuryToken?.address, wethToken?.address, address],
  )
  return getSellParam
}

const useSellAndUnwrapData = () => {
  const address = useAtomValue(addressAtom)
  const web3 = useAtomValue(web3Atom)
  const { swapRouter } = useAtomValue(addressesAtom)
  const getSellParam = useGetSellParam()
  const getSellQuote = useGetSellQuote()
  const sellAndUnwrapData = async (amount: BigNumber) => {
    if (!web3) return
    const exactInputParam = await getSellParam(amount)
    exactInputParam.recipient = swapRouter
    const tupleInput = Object.values(exactInputParam).map((v) => v?.toString() || '')
    const minimumAmountOut = fromTokenAmount((await getSellQuote(amount))!.minimumAmountOut, 18)
    const swapIface = new ethers.utils.Interface(routerABI)
    const encodedSwapCall = swapIface.encodeFunctionData('exactInputSingle', [tupleInput])
    const encodedUnwrapCall = swapIface.encodeFunctionData('unwrapWETH9(uint256,address)', [
      fromTokenAmount(minimumAmountOut, 18).toString(),
      address,
    ])
    return [encodedSwapCall, encodedUnwrapCall]
  }

  return sellAndUnwrapData
}

export const useSell = () => {
  const address = useAtomValue(addressAtom)
  const handleTransaction = useHandleTransaction()
  const swapRouterContract = useAtomValue(swapRouterContractAtom)
  const sellAndUnwrapData = useSellAndUnwrapData()

  const sell = async (amount: BigNumber, onTxConfirmed?: () => void) => {
    const callData = await sellAndUnwrapData(amount)

    const result = await handleTransaction(
      swapRouterContract?.methods.multicall(callData).send({
        from: address,
      }),
      onTxConfirmed,
    )

    return result
  }
  return sell
}

export const useAutoRoutedSell = () => {
  const networkId = useAtomValue(networkIdAtom)
  const address = useAtomValue(addressAtom)
  const wethToken = useAtomValue(wethTokenAtom)
  const { swapRouter2 } = useAtomValue(addressesAtom)
  const web3 = useAtomValue(web3Atom)
  const squfuryToken = useAtomValue(squfuryTokenAtom)
  const handleTransaction = useHandleTransaction()
  const swapRouter2Contract = useAtomValue(swapRouter2ContractAtom)
  const slippageAmount = useAtomValue(slippageAmountAtom)

  const autoRoutedSell = useAppCallback(
    async (amount: BigNumber, onTxConfirmed?: () => void) => {
      // Initializing the AlphaRouter
      const provider = new ethers.providers.Web3Provider(web3.currentProvider as any)
      const chainId = networkId as any as ChainId

      const gasPriceProvider = getGasPriceProvider(chainId)
      const router = new AlphaRouter({
        chainId: chainId,
        provider: provider as any,
        gasPriceProvider,
      })

      // Call Route
      const rawAmount = CurrencyAmount.fromRawAmount(
        squfuryToken!,
        fromTokenAmount(amount, OSQUFURY_DECIMALS).toFixed(0),
      )

      const slippageTolerance = slippageAmount ? slippageAmount : DEFAULT_SLIPPAGE
      const route = await router.route(rawAmount, wethToken!, TradeType.EXACT_INPUT, {
        recipient: swapRouter2,
        slippageTolerance: parseSlippageInput(slippageTolerance.toString()),
        deadline: Math.floor(Date.now() / 1000 + 1800),
      })

      const minimumAmountOut = new BigNumber(
        route?.trade.minimumAmountOut(parseSlippageInput(slippageTolerance.toString())).toFixed(18) || 0,
      )
      const swapIface = new ethers.utils.Interface(router2ABI)
      const encodedUnwrapCall = swapIface.encodeFunctionData('unwrapWETH9(uint256,address)', [
        fromTokenAmount(minimumAmountOut, 18).toString(),
        address,
      ])
      const result = await handleTransaction(
        swapRouter2Contract?.methods.multicall([route?.methodParameters?.calldata, encodedUnwrapCall]).send({
          from: address,
        }),
        onTxConfirmed,
      )
      return result
    },
    [address, slippageAmount],
  )

  return autoRoutedSell
}

export const useGetSellQuoteForETH = () => {
  const pool = useAtomValue(poolAtom)
  const squfuryToken = useAtomValue(squfuryTokenAtom)
  const wethToken = useAtomValue(wethTokenAtom)
  //I input an exact amount of ETH I want to receive, tells me how much squfury I'd need to sell
  const getSellQuoteForETH = useAppCallback(
    async (ETHAmount: BigNumber, slippageAmount = new BigNumber(DEFAULT_SLIPPAGE)) => {
      const emptyState = {
        amountIn: new BigNumber(0),
        maximumAmountIn: new BigNumber(0),
        priceImpact: '0',
      }
      if (!ETHAmount || !pool) return emptyState

      try {
        //squfury is input token, WETH is output token. I'm selling squfury for WETH
        const route = new Route([pool], squfuryToken!, wethToken!)
        //getting the amount of squfury I'd need to sell to receive my desired amount of ETH
        const rawAmount = CurrencyAmount.fromRawAmount(wethToken!, fromTokenAmount(ETHAmount, 18).toFixed(0))

        if (rawAmount.equalTo(0)) {
          return emptyState
        }

        const trade = await Trade.exactOut(route, rawAmount)

        //the amount of squfury I need to sell
        return {
          amountIn: new BigNumber(trade.inputAmount.toSignificant(18)),
          maximumAmountIn: new BigNumber(
            trade.maximumAmountIn(parseSlippageInput(slippageAmount.toString())).toSignificant(18),
          ),
          priceImpact: trade.priceImpact.toFixed(2),
        }
      } catch (e) {
        console.log(e)
      }

      return emptyState
    },
    [pool, squfuryToken, wethToken],
  )

  return getSellQuoteForETH
}

function getPoolInfo(route: SwapRoute, overallInputAmount: BigNumber) {
  const V2_DEFAULT_FEE_TIER = 3000
  const poolsUsed = []
  const swaps = route.trade.swaps
  for (let i = 0; i < swaps.length; i++) {
    const poolsInRoute = swaps[i].route.pools
    for (let j = 0; j < poolsInRoute.length; j++) {
      const pool = poolsInRoute[j]
      const portion = swaps[i].inputAmount.divide(route.trade.inputAmount)
      const percent = new Percent(portion.numerator, portion.denominator)
      poolsUsed.push(
        pool instanceof Pair
          ? ['V2', V2_DEFAULT_FEE_TIER, percent.toSignificant(2)]
          : ['V3', pool.fee, percent.toSignificant(2)],
      )
    }
  }
  return poolsUsed
}
