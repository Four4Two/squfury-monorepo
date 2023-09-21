import { useState } from 'react'
import { useAtomValue } from 'jotai'

import { squfuryInitialPriceAtom, squfuryInitialPriceErrorAtom } from '@state/squfuryPool/atoms'
import { useETHPrice } from '@hooks/useETHPrice'
import useAppEffect from '@hooks/useAppEffect'

export const useOSQFUPrice = () => {
  const [loading, setLoading] = useState(false)

  const ethPrice = useETHPrice()
  const squfuryPriceInETH = useAtomValue(squfuryInitialPriceAtom)
  const squfuryPriceError = useAtomValue(squfuryInitialPriceErrorAtom)

  const squfuryPrice = squfuryPriceInETH.times(ethPrice)

  useAppEffect(() => {
    if (squfuryPrice.isZero() && squfuryPriceError === '') {
      setLoading(true)
    } else {
      setLoading(false)
    }
  }, [squfuryPrice, squfuryPriceError])

  return { loading, data: squfuryPrice, error: squfuryPriceError }
}
