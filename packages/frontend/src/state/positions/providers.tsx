import BigNumber from 'bignumber.js'
import { createContext } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { useUpdateAtom } from 'jotai/utils'
import { BIG_ZERO, OSQUFURY_DECIMALS } from '@constants/index'
import { addressesAtom, isWethToken0Atom, positionTypeAtom, isToHidePnLAtom } from './atoms'
import { useUsdAmount } from '@hooks/useUsdAmount'
import { PositionType } from '../../types'
import { useFirstValidVault, useSwaps } from './hooks'
import useAppMemo from '@hooks/useAppMemo'
import { FC } from 'react'
import { useTokenBalance } from '@hooks/contracts/useTokenBalance'
import useAppEffect from '@hooks/useAppEffect'
interface ComputeSwapsContextValue {
  squfuryAmount: BigNumber
  wethAmount: BigNumber
  longUsdAmount: BigNumber
  shortUsdAmount: BigNumber
  boughtSquFury: BigNumber
  soldSquFury: BigNumber
  totalUSDFromBuy: BigNumber
  totalUSDFromSell: BigNumber
  loading: Boolean
}

export const ComputeSwapsContext = createContext<ComputeSwapsContextValue | null>(null)

export const ComputeSwapsProvider: FC = ({ children }) => {
  const isWethToken0 = useAtomValue(isWethToken0Atom)
  const [positionType, setPositionType] = useAtom(positionTypeAtom)
  const setIsToHidePnL = useUpdateAtom(isToHidePnLAtom)
  const { getUsdAmt } = useUsdAmount()
  const { data, loading } = useSwaps()
  const { oSquFury } = useAtomValue(addressesAtom)
  const { value: oSquFuryBal, refetch } = useTokenBalance(oSquFury, 15, OSQUFURY_DECIMALS)
  const { validVault: vault } = useFirstValidVault()

  const computedSwaps = useAppMemo(
    () =>
      data?.swaps.reduce(
        (acc, s) => {
          //values are all from the pool pov
          //if >0 for the pool, user gave some squfury to the pool, meaning selling the squfury
          const squfuryAmt = new BigNumber(isWethToken0 ? s.amount1 : s.amount0)
          const wethAmt = new BigNumber(isWethToken0 ? s.amount0 : s.amount1)
          const usdAmt = getUsdAmt(wethAmt, s.timestamp)
          //buy one squfury means -1 to the pool, +1 to the user
          acc.squfuryAmount = acc.squfuryAmount.plus(squfuryAmt.negated())
          //<0 means, buying squfury
          //>0 means selling squfury
          if (squfuryAmt.isPositive()) {
            //sold SquFury amount
            acc.soldSquFury = acc.soldSquFury.plus(squfuryAmt.abs())
            //usd value from sell to close long position or open short
            acc.totalUSDFromSell = acc.totalUSDFromSell.plus(usdAmt.abs())
          } else if (squfuryAmt.isNegative()) {
            //bought SquFury amount
            acc.boughtSquFury = acc.boughtSquFury.plus(squfuryAmt.abs())
            //usd value from buy to close short position or open long
            acc.totalUSDFromBuy = acc.totalUSDFromBuy.plus(usdAmt.abs())
          }
          if (acc.squfuryAmount.isZero()) {
            acc.longUsdAmount = BIG_ZERO
            acc.shortUsdAmount = BIG_ZERO
            acc.wethAmount = BIG_ZERO
            acc.boughtSquFury = BIG_ZERO
            acc.soldSquFury = BIG_ZERO
            acc.totalUSDFromSell = BIG_ZERO
            acc.totalUSDFromBuy = BIG_ZERO
          } else {
            // when the position is partially closed, will accumulate usdamount
            acc.longUsdAmount = acc.longUsdAmount.plus(usdAmt)
            acc.shortUsdAmount = acc.shortUsdAmount.plus(usdAmt.negated())
            acc.wethAmount = acc.wethAmount.plus(wethAmt.negated())
          }
          return acc
        },
        {
          squfuryAmount: BIG_ZERO,
          wethAmount: BIG_ZERO,
          longUsdAmount: BIG_ZERO,
          shortUsdAmount: BIG_ZERO,
          boughtSquFury: BIG_ZERO,
          soldSquFury: BIG_ZERO,
          totalUSDFromBuy: BIG_ZERO,
          totalUSDFromSell: BIG_ZERO,
        },
      ) || {
        squfuryAmount: BIG_ZERO,
        wethAmount: BIG_ZERO,
        longUsdAmount: BIG_ZERO,
        shortUsdAmount: BIG_ZERO,
        boughtSquFury: BIG_ZERO,
        soldSquFury: BIG_ZERO,
        totalUSDFromBuy: BIG_ZERO,
        totalUSDFromSell: BIG_ZERO,
      },
    [isWethToken0, data?.swaps, getUsdAmt],
  )

  useAppEffect(() => {
    if (oSquFuryBal?.isGreaterThan(0) && oSquFuryBal.isGreaterThan(vault?.shortAmount || 0)) {
      setPositionType(PositionType.LONG)
      // check if user osqfu wallet balance is equal to the accumulated amount from tx history
      // if it's not the same, it's likely that they do smt on crab acution or otc or lp etc so dont show the pnl for them
      if (!computedSwaps.squfuryAmount.isEqualTo(oSquFuryBal)) {
        setIsToHidePnL(true)
      } else {
        setIsToHidePnL(false)
      }
    } else if (oSquFuryBal.isLessThan(vault?.shortAmount || 0)) {
      setIsToHidePnL(true)
      setPositionType(PositionType.SHORT)
    } else {
      setIsToHidePnL(false)
      setPositionType(PositionType.NONE)
    }
  }, [computedSwaps.squfuryAmount, oSquFuryBal, setPositionType, setIsToHidePnL, vault?.shortAmount])

  useAppEffect(() => {
    refetch()
  }, [computedSwaps.squfuryAmount, refetch])

  const value = useAppMemo(
    () => ({
      ...computedSwaps,
      loading,
      squfuryAmount:
        positionType === PositionType.LONG ? oSquFuryBal : vault?.shortAmount.minus(oSquFuryBal) || BIG_ZERO,
    }),
    [computedSwaps, loading, positionType, oSquFuryBal, vault?.shortAmount],
  )

  return <ComputeSwapsContext.Provider value={value}>{children}</ComputeSwapsContext.Provider>
}
