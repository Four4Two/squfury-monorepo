import { nearestUsableTick, TickMath } from '@uniswap/v3-sdk'
import { fromTokenAmount, toTokenAmount } from '@utils/calculations'
import { useAtomValue } from 'jotai'
import { addressesAtom, isWethToken0Atom } from '../positions/atoms'
import BigNumber from 'bignumber.js'
import { INDEX_SCALE, OSQUFURY_DECIMALS, WETH_DECIMALS } from '@constants/index'
import {
  controllerContractAtom,
  controllerHelperHelperContractAtom,
  nftManagerContractAtom,
  quoterContractAtom,
  squfuryPoolContractAtom,
} from '../contracts/atoms'
import useAppCallback from '@hooks/useAppCallback'
import { addressAtom } from '../wallet/atoms'
import { Contract } from 'web3-eth-contract'
import { useHandleTransaction } from '../wallet/hooks'
import { ethers } from 'ethers'
import { useCallback } from 'react'
import { useGetDebtAmount, useGetVault } from '../controller/hooks'
import { indexAtom, normFactorAtom } from '../controller/atoms'

/*** CONSTANTS ***/
const COLLAT_RATIO_FLASHLOAN = 2
const POOL_FEE = 3000
const MAX_INT_128 = new BigNumber(2).pow(128).minus(1).toFixed(0)
const x96 = new BigNumber(2).pow(96)
const FLASHLOAN_BUFFER = 0.02

/*** ACTIONS ***/

// Opening a mint and LP position and depositing
export const useOpenPositionDeposit = () => {
  const { squfuryPool } = useAtomValue(addressesAtom)
  const address = useAtomValue(addressAtom)
  const contract = useAtomValue(controllerHelperHelperContractAtom)
  const handleTransaction = useHandleTransaction()
  const getDebtAmount = useGetDebtAmount()
  const squfuryPoolContract = useAtomValue(squfuryPoolContractAtom)
  const isWethToken0 = useAtomValue(isWethToken0Atom)
  const index = useAtomValue(indexAtom)
  const normFactor = useAtomValue(normFactorAtom)
  const getVault = useGetVault()
  const getCollateralToLP = useGetCollateralToLP()
  const openPositionDeposit = useAppCallback(
    async (
      squfuryToMint: BigNumber,
      lowerTickInput: number,
      upperTickInput: number,
      vaultId: number,
      collatRatio: number,
      slippage: number,
      withdrawAmount: number,
      onTxConfirmed?: () => void,
    ) => {
      const vaultBefore = await getVault(vaultId)
      if (
        !contract ||
        !address ||
        !squfuryPoolContract ||
        !vaultBefore ||
        !vaultBefore.shortAmount ||
        !vaultBefore.collateralAmount
      )
        return null

      const mintWSquFuryAmount = fromTokenAmount(squfuryToMint, OSQUFURY_DECIMALS)
      const { tick, tickSpacing } = await getPoolState(squfuryPoolContract)
      const lowerTick = nearestUsableTick(lowerTickInput, Number(tickSpacing))
      const upperTick = nearestUsableTick(upperTickInput, Number(tickSpacing))

      const collateralToLp = await getCollateralToLP(mintWSquFuryAmount, lowerTick, upperTick, tick)
      if (!collateralToLp) return

      const amount0New = isWethToken0 ? collateralToLp : mintWSquFuryAmount
      const amount1New = isWethToken0 ? mintWSquFuryAmount : collateralToLp
      const amount0Min = amount0New.times(new BigNumber(1).minus(slippage)).toFixed(0)
      const amount1Min = amount1New.times(new BigNumber(1).minus(slippage)).toFixed(0)

      const collateralToWithdraw = fromTokenAmount(withdrawAmount, OSQUFURY_DECIMALS)
      const ethIndexPrice = toTokenAmount(index, 18).sqrt()
      const vaultShortAmt = fromTokenAmount(vaultBefore.shortAmount, OSQUFURY_DECIMALS)
      const vaultCollateralAmt = fromTokenAmount(vaultBefore.collateralAmount, WETH_DECIMALS)

      // Calculate collateralToMint
      const oSQFUInETH = mintWSquFuryAmount.times(ethIndexPrice.div(INDEX_SCALE)).times(normFactor)
      const collateralToMint = new BigNumber(collatRatio)
        .times(vaultShortAmt.plus(mintWSquFuryAmount).times(normFactor).times(ethIndexPrice).div(INDEX_SCALE))
        .minus(vaultCollateralAmt.minus(collateralToWithdraw).plus(collateralToLp).plus(oSQFUInETH))
      const flashLoanAmount = new BigNumber(COLLAT_RATIO_FLASHLOAN + FLASHLOAN_BUFFER)
        .times(vaultShortAmt.plus(mintWSquFuryAmount))
        .times(normFactor)
        .times(ethIndexPrice)
        .div(INDEX_SCALE)
        .minus(vaultCollateralAmt)
      const collateralToMintPos = BigNumber.max(collateralToMint, 0)
      const flashLoanAmountPos = BigNumber.max(flashLoanAmount, 0)

      const flashloanWMintDepositNftParams = {
        wPowerPerpPool: squfuryPool,
        vaultId: vaultId,
        wPowerPerpAmount: mintWSquFuryAmount.toFixed(0),
        collateralToDeposit: collateralToMintPos.plus(flashLoanAmountPos).toFixed(0),
        collateralToFlashloan: flashLoanAmountPos.toFixed(0),
        collateralToLp: collateralToLp.toFixed(0),
        collateralToWithdraw: collateralToWithdraw.toFixed(0),
        amount0Min,
        amount1Min,
        lowerTick: lowerTick,
        upperTick: upperTick,
      }

      return handleTransaction(
        contract.methods.flashloanWMintLpDepositNft(flashloanWMintDepositNftParams).send({
          from: address,
          value: collateralToLp.plus(collateralToMintPos).minus(collateralToWithdraw).toFixed(0),
        }),
        onTxConfirmed,
      )
    },
    [
      address,
      squfuryPool,
      contract,
      handleTransaction,
      getDebtAmount,
      squfuryPoolContract,
      isWethToken0,
      index,
      normFactor,
      getVault,
    ],
  )

  return openPositionDeposit
}

/*** GETTERS ***/

export const useGetPosition = () => {
  const contract = useAtomValue(nftManagerContractAtom)

  const getPosition = useCallback(
    async (uniTokenId: number) => {
      if (!contract) return null
      const position = await contract.methods.positions(uniTokenId).call()
      const {
        nonce,
        operator,
        token0,
        token1,
        fee,
        tickLower,
        tickUpper,
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      } = position
      return {
        nonce,
        operator,
        token0,
        token1,
        fee,
        tickLower,
        tickUpper,
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      }
    },
    [contract],
  )

  return getPosition
}

export const useGetLiquidity = () => {
  const isWethToken0 = useAtomValue(isWethToken0Atom)

  const getLiquidity = useCallback(
    async (
      squfuryAmount: BigNumber,
      sqrtLowerPrice: BigNumber,
      sqrtUpperPrice: BigNumber,
      sqrtSquFuryPrice: BigNumber,
    ) => {
      if (isWethToken0) {
        // Ly = y / (sqrtSquFuryPrice - sqrtLowerPrice)
        return squfuryAmount.div(sqrtSquFuryPrice.minus(sqrtLowerPrice))
      } else {
        // Lx = x * (sqrtSquFuryPrice * sqrtUpperPrice) / (sqrtUpperPrice - sqrtSquFuryPrice)
        return squfuryAmount.times(sqrtSquFuryPrice.times(sqrtUpperPrice)).div(sqrtUpperPrice.minus(sqrtSquFuryPrice))
      }
    },
    [isWethToken0],
  )

  return getLiquidity
}

export const useGetCollateralToLP = () => {
  const isWethToken0 = useAtomValue(isWethToken0Atom)
  const getLiquidity = useGetLiquidity()
  const getTickPrices = useGetTickPrices()

  const getCollateralToLP = useCallback(
    async (squfuryAmount: BigNumber, lowerTick: Number, upperTick: Number, tick: number) => {
      const { sqrtLowerPrice, sqrtUpperPrice, sqrtSquFuryPrice } = await getTickPrices(lowerTick, upperTick, tick)

      if (
        (sqrtUpperPrice.lt(sqrtSquFuryPrice) && !isWethToken0) ||
        (sqrtLowerPrice.gt(sqrtSquFuryPrice) && isWethToken0)
      ) {
        // All weth position
        console.log('LPing an all WETH position is not enabled, but you can rebalance to this position.')
        return
      } else if (
        (sqrtLowerPrice.gt(sqrtSquFuryPrice) && !isWethToken0) ||
        (sqrtUpperPrice.lt(sqrtSquFuryPrice) && isWethToken0)
      ) {
        // All squfury position
        return new BigNumber(0)
      } else {
        // isWethToken0  -> x = Ly * (sqrtUpperPrice - sqrtSquFuryPrice)/(sqrtSquFuryPrice * sqrtUpperPrice)
        // !isWethToken0 -> y = Lx * (sqrtSquFuryPrice - sqrtLowerPrice)

        const liquidity = await getLiquidity(squfuryAmount, sqrtLowerPrice, sqrtUpperPrice, sqrtSquFuryPrice)
        return isWethToken0
          ? liquidity.times(sqrtUpperPrice.minus(sqrtSquFuryPrice)).div(sqrtSquFuryPrice.times(sqrtUpperPrice))
          : liquidity.times(sqrtSquFuryPrice.minus(sqrtLowerPrice))
      }
    },
    [isWethToken0, getLiquidity],
  )

  return getCollateralToLP
}

export const useGetTickPrices = () => {
  const getTickPrices = useCallback(async (lowerTick: Number, upperTick: Number, currentTick: number) => {
    const sqrtLowerPrice = new BigNumber(TickMath.getSqrtRatioAtTick(Number(lowerTick)).toString()).div(x96)
    const sqrtUpperPrice = new BigNumber(TickMath.getSqrtRatioAtTick(Number(upperTick)).toString()).div(x96)
    const sqrtSquFuryPrice = new BigNumber(TickMath.getSqrtRatioAtTick(Number(currentTick)).toString()).div(x96)
    return { sqrtLowerPrice, sqrtUpperPrice, sqrtSquFuryPrice }
  }, [])

  return getTickPrices
}

export const useGetDecreaseLiquidity = () => {
  const contract = useAtomValue(nftManagerContractAtom)

  const getDecreaseLiquiduity = useCallback(
    async (tokenId: number, liquidity: number, amount0Min: number, amount1Min: number, deadline: number) => {
      if (!contract) return null
      const DecreaseLiquidityParams = {
        tokenId,
        liquidity,
        amount0Min,
        amount1Min,
        deadline,
      }

      const decreaseLiquidity = await contract.methods.decreaseLiquidity(DecreaseLiquidityParams).call()

      return decreaseLiquidity
    },
    [contract],
  )

  return getDecreaseLiquiduity
}

export const useGetExactIn = () => {
  const contract = useAtomValue(quoterContractAtom)
  const { weth, oSquFury } = useAtomValue(addressesAtom)

  const getExactIn = useCallback(
    async (amount: BigNumber, squfuryIn: boolean) => {
      if (!contract) return null

      const QuoteExactInputSingleParams = {
        tokenIn: squfuryIn ? oSquFury : weth,
        tokenOut: squfuryIn ? weth : oSquFury,
        amountIn: amount.toFixed(0),
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0,
      }

      const quote = await contract.methods.quoteExactInputSingle(QuoteExactInputSingleParams).call()
      return quote.amountOut
    },
    [contract, weth, oSquFury],
  )

  return getExactIn
}

export const useGetExactOut = () => {
  const contract = useAtomValue(quoterContractAtom)
  const { weth, oSquFury } = useAtomValue(addressesAtom)

  const getExactOut = useCallback(
    async (amount: BigNumber, squfuryOut: boolean) => {
      if (!contract) return null

      const QuoteExactOutputSingleParams = {
        tokenIn: squfuryOut ? weth : oSquFury,
        tokenOut: squfuryOut ? oSquFury : weth,
        amount: amount.toFixed(0),
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0,
      }

      const quote = await contract.methods.quoteExactOutputSingle(QuoteExactOutputSingleParams).call()
      return quote.amountIn
    },
    [contract, weth, oSquFury],
  )

  return getExactOut
}

async function getPoolState(poolContract: Contract) {
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