import { useState } from 'react'
import { useAtom, useAtomValue, atom } from 'jotai'
import { useUpdateAtom } from 'jotai/utils'
import { useQuery } from '@apollo/client'
import { useContext } from 'react'
import BigNumber from 'bignumber.js'
import { Position } from '@uniswap/v3-sdk'

import { networkIdAtom, addressAtom } from '../wallet/atoms'
import { swaps, swapsVariables } from '@queries/uniswap/__generated__/swaps'
import SWAPS_QUERY, { SWAPS_SUBSCRIPTION } from '@queries/uniswap/swapsQuery'
import SWAPS_ROPSTEN_QUERY, { SWAPS_ROPSTEN_SUBSCRIPTION } from '@queries/uniswap/swapsRopstenQuery'
import { VAULT_QUERY } from '@queries/squfury/vaultsQuery'
import { BIG_ZERO, OSQUFURY_DECIMALS } from '@constants/index'
import {
  addressesAtom,
  isWethToken0Atom,
  positionTypeAtom,
  managerAtom,
  activePositionsAtom,
  closedPositionsAtom,
  squfuryLiquidityAtom,
  wethLiquidityAtom,
  depositedSquFuryAtom,
  depositedWethAtom,
  withdrawnSquFuryAtom,
  withdrawnWethAtom,
  swapsAtom,
} from './atoms'
import { positions, positionsVariables } from '@queries/uniswap/__generated__/positions'
import POSITIONS_QUERY, { POSITIONS_SUBSCRIPTION } from '@queries/uniswap/positionsQuery'
import { useVaultManager } from '@hooks/contracts/useVaultManager'
import { useTokenBalance } from '@hooks/contracts/useTokenBalance'
import { toTokenAmount } from '@utils/calculations'
import { squfuryClient } from '@utils/apollo-client'
import { PositionType, Networks } from '../../types'
import { poolAtom, squfuryInitialPriceAtom } from '../squfuryPool/atoms'
import { useETHPrice } from '@hooks/useETHPrice'
import { useGetWSquFuryPositionValue } from '../squfuryPool/hooks'
import { useVaultHistory } from '@hooks/useVaultHistory'
import { swapsRopsten, swapsRopstenVariables } from '@queries/uniswap/__generated__/swapsRopsten'
import { Vault } from '@queries/squfury/__generated__/Vault'
import { ComputeSwapsContext } from './providers'
import useAppEffect from '@hooks/useAppEffect'
import useAppMemo from '@hooks/useAppMemo'

export const useSwaps = () => {
  const [networkId] = useAtom(networkIdAtom)
  const [address] = useAtom(addressAtom)
  const setSwaps = useUpdateAtom(swapsAtom)
  const { squfuryPool, oSquFury, shortHelper, swapRouter, crabStrategy, crabStrategy2, flashBull, bullStrategy } =
    useAtomValue(addressesAtom)
  const { subscribeToMore, data, refetch, loading, error, startPolling, stopPolling } = useQuery<
    swaps | swapsRopsten,
    swapsVariables | swapsRopstenVariables
  >(networkId === Networks.MAINNET ? SWAPS_QUERY : SWAPS_ROPSTEN_QUERY, {
    variables: {
      origin: address || '',
      orderDirection: 'asc',
      recipient_not_in: [crabStrategy, crabStrategy2, flashBull, bullStrategy],
      ...(networkId === Networks.MAINNET
        ? {
            tokenAddress: oSquFury,
          }
        : {
            poolAddress: squfuryPool,
            recipients: [shortHelper, address || '', swapRouter],
          }),
    },
    fetchPolicy: 'cache-and-network',
  })

  useAppEffect(() => {
    subscribeToMore({
      document: networkId === Networks.MAINNET ? SWAPS_SUBSCRIPTION : SWAPS_ROPSTEN_SUBSCRIPTION,
      variables: {
        origin: address || '',
        orderDirection: 'asc',
        recipient_not_in: [crabStrategy, crabStrategy2,  flashBull, bullStrategy],
        ...(networkId === Networks.MAINNET
          ? {
              tokenAddress: oSquFury,
            }
          : {
              poolAddress: squfuryPool,
              recipients: [shortHelper, address || '', swapRouter],
            }),
      },
      updateQuery(prev, { subscriptionData }) {
        if (!subscriptionData.data) return prev
        const newSwaps = subscriptionData.data.swaps
        return {
          swaps: newSwaps,
        }
      },
    })
  }, [address, crabStrategy, networkId, oSquFury, shortHelper, squfuryPool, swapRouter, subscribeToMore])

  useAppEffect(() => {
    if (data?.swaps) {
      setSwaps({ swaps: data?.swaps })
    } else {
      setSwaps({ swaps: [] })
    }
  }, [data?.swaps, setSwaps])

  return { data, refetch, loading, error, startPolling, stopPolling }
}

export const useComputeSwaps = () => {
  const context = useContext(ComputeSwapsContext)

  if (!context) {
    throw new Error('useComputeSwaps must be used inside ComputeSwapsProvider')
  }

  return context
}

export const useLongRealizedPnl = () => {
  const { boughtSquFury, soldSquFury, totalUSDFromBuy, totalUSDFromSell } = useComputeSwaps()
  return useAppMemo(() => {
    if (!soldSquFury.gt(0)) return BIG_ZERO
    const costForOneSqfu = !totalUSDFromBuy.isEqualTo(0) ? totalUSDFromBuy.div(boughtSquFury) : BIG_ZERO
    const realizedForOneSqfu = !totalUSDFromSell.isEqualTo(0) ? totalUSDFromSell.div(soldSquFury) : BIG_ZERO
    const pnlForOneSqfu = realizedForOneSqfu.minus(costForOneSqfu)

    return pnlForOneSqfu.multipliedBy(soldSquFury)
  }, [boughtSquFury, soldSquFury, totalUSDFromBuy, totalUSDFromSell])
}

export const useShortRealizedPnl = () => {
  const { boughtSquFury, soldSquFury, totalUSDFromBuy, totalUSDFromSell } = useComputeSwaps()
  return useAppMemo(() => {
    if (!boughtSquFury.gt(0)) return BIG_ZERO

    const costForOneSqfu = !totalUSDFromSell.isEqualTo(0) ? totalUSDFromSell.div(soldSquFury) : BIG_ZERO
    const realizedForOneSqfu = !totalUSDFromBuy.isEqualTo(0) ? totalUSDFromBuy.div(boughtSquFury) : BIG_ZERO
    const pnlForOneSqfu = realizedForOneSqfu.minus(costForOneSqfu)

    return pnlForOneSqfu.multipliedBy(boughtSquFury)
  }, [boughtSquFury, totalUSDFromBuy, soldSquFury, totalUSDFromSell])
}

export const useMintedSoldSort = () => {
  const { vaultId } = useFirstValidVault()
  const { openShortSquFury } = useVaultHistory(Number(vaultId))
  const positionType = useAtomValue(positionTypeAtom)
  const { squfuryAmount } = useComputeSwaps()

  //when the squfuryAmount < 0 and the abs amount is greater than openShortSquFury, that means there is manually sold short position
  return useAppMemo(() => {
    return positionType === PositionType.SHORT && squfuryAmount.abs().isGreaterThan(openShortSquFury)
      ? squfuryAmount.abs().minus(openShortSquFury)
      : new BigNumber(0)
  }, [positionType, squfuryAmount, openShortSquFury])
}

export const useMintedDebt = () => {
  const { vaultId } = useFirstValidVault()
  const { mintedSquFury } = useVaultHistory(Number(vaultId))
  const lpDebt = useLpDebt()
  const mintedSoldShort = useMintedSoldSort()

  //mintedSquFury balance from vault histroy - mintedSold short position = existing mintedDebt in vault, but
  //LPed amount wont be taken into account from vault history, so will need to be deducted here and added the withdrawn amount back
  //if there is LP Debt, shld be deducted from minted Debt
  const mintedDebt = useAppMemo(() => {
    return mintedSquFury.minus(mintedSoldShort).minus(lpDebt)
  }, [mintedSquFury, mintedSoldShort, lpDebt])

  return mintedDebt
}

export const useShortDebt = () => {
  const positionType = useAtomValue(positionTypeAtom)
  const { squfuryAmount } = useComputeSwaps()
  const shortDebt = useAppMemo(() => {
    return positionType === PositionType.SHORT ? squfuryAmount : new BigNumber(0)
  }, [positionType, squfuryAmount])

  return shortDebt.absoluteValue()
}

export const useLongSqfuBal = () => {
  const { oSquFury } = useAtomValue(addressesAtom)
  const { value: oSquFuryBal, loading, error, refetch } = useTokenBalance(oSquFury, 15, OSQUFURY_DECIMALS)
  const mintedDebt = useMintedDebt()
  const longSqfuBal = useAppMemo(() => {
    return mintedDebt.gt(0) ? oSquFuryBal.minus(mintedDebt) : oSquFuryBal
  }, [oSquFuryBal, mintedDebt])
  return { longSqfuBal, loading, error, refetch }
}

export const useLpDebt = () => {
  const depositedSquFury = useAtomValue(depositedSquFuryAtom)
  const withdrawnSquFury = useAtomValue(withdrawnSquFuryAtom)
  const lpDebt = useAppMemo(() => {
    return depositedSquFury.minus(withdrawnSquFury).isGreaterThan(0)
      ? depositedSquFury.minus(withdrawnSquFury)
      : new BigNumber(0)
  }, [depositedSquFury, withdrawnSquFury])

  return lpDebt
}

export const useLPPositionsQuery = () => {
  const { squfuryPool } = useAtomValue(addressesAtom)
  const address = useAtomValue(addressAtom)
  const { data, refetch, loading, subscribeToMore } = useQuery<positions, positionsVariables>(POSITIONS_QUERY, {
    variables: {
      poolAddress: squfuryPool?.toLowerCase(),
      owner: address?.toLowerCase() || '',
    },
    fetchPolicy: 'cache-and-network',
  })

  useAppEffect(() => {
    subscribeToMore({
      document: POSITIONS_SUBSCRIPTION,
      variables: {
        poolAddress: squfuryPool?.toLowerCase(),
        owner: address?.toLowerCase() || '',
      },
      updateQuery(prev, { subscriptionData }) {
        if (!subscriptionData.data) return prev
        const newPosition = subscriptionData.data.positions
        return {
          positions: newPosition,
        }
      },
    })
  }, [address, squfuryPool, subscribeToMore])

  return { data, refetch, loading }
}

const MAX_UNIT = '0xffffffffffffffffffffffffffffffff'
const positionFeesAtom = atom<any[]>([])
export const useLPPositionsAndFees = () => {
  const manager = useAtomValue(managerAtom)
  const address = useAtomValue(addressAtom)
  const isWethToken0 = useAtomValue(isWethToken0Atom)
  const pool = useAtomValue(poolAtom)
  const squfuryInitialPrice = useAtomValue(squfuryInitialPriceAtom)
  const getWSquFuryPositionValue = useGetWSquFuryPositionValue()
  const { data } = useLPPositionsQuery()
  const ethPrice = useETHPrice()
  const [positionFees, setPositionFees] = useAtom(positionFeesAtom)

  useAppEffect(() => {
    ;(async function handlePositionFees() {
      if (!pool || !squfuryInitialPrice.toNumber() || !ethPrice.toNumber() || !data) return []

      const positionFeesP = data.positions.map(async (p) => {
        const position = { ...p }
        const tokenIdHexString = new BigNumber(position.id).toString()
        const uniPosition = new Position({
          pool,
          liquidity: position.liquidity.toString(),
          tickLower: Number(position.tickLower.tickIdx),
          tickUpper: Number(position.tickUpper.tickIdx),
        })

        const fees = await manager.methods
          .collect({
            tokenId: tokenIdHexString,
            recipient: address,
            amount0Max: MAX_UNIT,
            amount1Max: MAX_UNIT,
          })
          .call()

        const squfuryAmt = isWethToken0
          ? new BigNumber(uniPosition.amount1.toSignificant(18))
          : new BigNumber(uniPosition.amount0.toSignificant(18))

        const wethAmt = isWethToken0
          ? new BigNumber(uniPosition.amount0.toSignificant(18))
          : new BigNumber(uniPosition.amount1.toSignificant(18))

        const squfuryFees = isWethToken0 ? toTokenAmount(fees?.amount1, 18) : toTokenAmount(fees?.amount0, 18)
        const wethFees = isWethToken0 ? toTokenAmount(fees?.amount0, 18) : toTokenAmount(fees?.amount1, 18)

        const dollarValue = getWSquFuryPositionValue(squfuryAmt)
          .plus(getWSquFuryPositionValue(squfuryFees))
          .plus(wethAmt.times(ethPrice))
          .plus(wethFees.times(ethPrice))

        return {
          ...position,
          amount0: new BigNumber(uniPosition.amount0.toSignificant(18)),
          amount1: new BigNumber(uniPosition.amount1.toSignificant(18)),
          fees0: toTokenAmount(fees?.amount0, 18),
          fees1: toTokenAmount(fees?.amount1, 18),
          dollarValue,
        }
      })

      setPositionFees(await Promise.all(positionFeesP))
    })()
  }, [
    ethPrice,
    squfuryInitialPrice,
    data?.positions,
    address,
    data,
    getWSquFuryPositionValue,
    isWethToken0,
    manager.methods,
    pool,
    setPositionFees,
  ])

  return positionFees
}

export const usePositionsAndFeesComputation = () => {
  const isWethToken0 = useAtomValue(isWethToken0Atom)
  const [activePositions, setActivePositions] = useAtom(activePositionsAtom)
  const setClosedPositions = useUpdateAtom(closedPositionsAtom)
  const setDepositedSquFury = useUpdateAtom(depositedSquFuryAtom)
  const setDepositedWeth = useUpdateAtom(depositedWethAtom)
  const setWithdrawnSquFury = useUpdateAtom(withdrawnSquFuryAtom)
  const setWithdrawnWeth = useUpdateAtom(withdrawnWethAtom)
  const setWethLiquidity = useUpdateAtom(wethLiquidityAtom)
  const setSquFuryLiquidity = useUpdateAtom(squfuryLiquidityAtom)

  const positionAndFees = useLPPositionsAndFees()
  const { loading: gphLoading } = useLPPositionsQuery()

  useAppEffect(() => {
    if (positionAndFees && !gphLoading) {
      // Promise.all(positionAndFees).then((values: any[]) => {
      setActivePositions(positionAndFees.filter((p) => p.amount0.gt(0) || p.amount1.gt(0)))
      setClosedPositions(positionAndFees.filter((p) => p.amount0.isZero() && p.amount1.isZero()))
      // Calculate cumulative LP position here
      let depSqfu = new BigNumber(0)
      let depWeth = new BigNumber(0)
      let withSqfu = new BigNumber(0)
      let withWeth = new BigNumber(0)
      let sqfuLiq = new BigNumber(0)
      let wethLiq = new BigNumber(0)
      for (const position of positionAndFees) {
        sqfuLiq = sqfuLiq.plus(isWethToken0 ? position.amount1 : position.amount0)
        wethLiq = wethLiq.plus(isWethToken0 ? position.amount0 : position.amount1)
        depSqfu = depSqfu.plus(isWethToken0 ? position.depositedToken1 : position.depositedToken0)
        depWeth = depWeth.plus(isWethToken0 ? position.depositedToken0 : position.depositedToken1)
        withSqfu = withSqfu.plus(
          isWethToken0
            ? new BigNumber(position.withdrawnToken1).plus(position.collectedFeesToken1)
            : new BigNumber(position.withdrawnToken0).plus(position.collectedFeesToken0),
        )
        withWeth = withWeth.plus(
          !isWethToken0
            ? new BigNumber(position.withdrawnToken1).plus(position.collectedFeesToken1)
            : new BigNumber(position.withdrawnToken0).plus(position.collectedFeesToken0),
        )
      }

      setDepositedSquFury(depSqfu)
      setDepositedWeth(depWeth)
      setWithdrawnSquFury(withSqfu)
      setWithdrawnWeth(withWeth)
      setSquFuryLiquidity(sqfuLiq)
      setWethLiquidity(wethLiq)
    }
  }, [
    gphLoading,
    isWethToken0,
    positionAndFees,
    activePositions.length,
    setActivePositions,
    setClosedPositions,
    setDepositedSquFury,
    setDepositedWeth,
    setSquFuryLiquidity,
    setWethLiquidity,
    setWithdrawnSquFury,
    setWithdrawnWeth,
  ])
}

export const useVaultQuery = (vaultId: number) => {
  const networkId = useAtomValue(networkIdAtom)

  const query = useQuery<Vault>(VAULT_QUERY, {
    client: squfuryClient[networkId],
    fetchPolicy: 'cache-and-network',
    variables: {
      vaultID: vaultId,
    },
  })

  const vaultData = useAppMemo(() => {
    if (query.data) {
      const vault = query.data.vault

      return {
        id: vault?.id,
        NFTCollateralId: vault?.NftCollateralId,
        collateralAmount: toTokenAmount(new BigNumber(vault?.collateralAmount), 18),
        shortAmount: toTokenAmount(new BigNumber(vault?.shortAmount), OSQUFURY_DECIMALS),
        operator: vault?.operator,
      }
    }
  }, [query.data])

  return { ...query, data: vaultData }
}

export const useFirstValidVault = () => {
  const { vaults: shortVaults, loading } = useVaultManager()

  const vault = shortVaults?.find((vault) => vault.collateralAmount.isGreaterThan(0))

  return {
    isVaultLoading: loading,
    vaultId: Number(vault?.id) || 0,
    validVault: vault,
  }
}
