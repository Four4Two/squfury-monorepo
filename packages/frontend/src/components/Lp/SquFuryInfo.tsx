import { Box, BoxProps } from '@material-ui/core'
import React from 'react'
import { useAtomValue } from 'jotai'

import { Tooltips } from '@constants/enums'
import { BIG_ZERO } from '@constants/index'
import { toTokenAmount } from '@utils/calculations'
import {
  impliedVolAtom,
  indexAtom,
  markAtom,
  osqfuRefVolAtom,
  currentImpliedFundingAtom,
} from '@state/controller/atoms'
import Metric, { MetricLabel } from '@components/Metric'
import { formatCurrency, formatNumber } from '@utils/formatter'
import { useOSQFUPrice } from '@hooks/useOSQFUPrice'

const SquFuryInfo: React.FC<BoxProps> = (props) => {
  const mark = useAtomValue(markAtom)
  const index = useAtomValue(indexAtom)
  const impliedVol = useAtomValue(impliedVolAtom)
  const osqfuRefVol = useAtomValue(osqfuRefVolAtom)
  const currentImpliedFunding = useAtomValue(currentImpliedFundingAtom)
  const { data: osqfuPrice } = useOSQFUPrice()

  const eth2Price = toTokenAmount(index, 18)
  const ethPrice = eth2Price.sqrt()
  const markPrice = toTokenAmount(mark, 18)
  const impliedVolPercent = impliedVol * 100
  const currentImpliedPremium =
    currentImpliedFunding === 0 ? 'loading' : formatNumber(currentImpliedFunding * 100) + '%'

  const osqfuPriceInETH = ethPrice.isZero() ? BIG_ZERO : osqfuPrice.div(ethPrice)

  return (
    <Box display="flex" alignItems="center" flexWrap="wrap" gridGap="12px" {...props}>
      <Metric
        label={<MetricLabel label="ETH Price" tooltipTitle={Tooltips.SpotPrice} />}
        value={formatCurrency(ethPrice.toNumber())}
      />

      <Metric
        label={<MetricLabel label="ETH&sup2; Price" tooltipTitle={Tooltips.SpotPrice} />}
        value={formatCurrency(eth2Price.toNumber())}
      />

      <Metric
        label={<MetricLabel label="Mark Price" tooltipTitle={`${Tooltips.Mark}. ${Tooltips.SpotPrice}`} />}
        value={formatCurrency(markPrice.toNumber())}
      />

      <Metric
        label={<MetricLabel label="oSQFU Price" tooltipTitle={`${Tooltips.oSQFUPrice}. ${Tooltips.SpotPrice}`} />}
        value={`${formatCurrency(osqfuPrice.toNumber())}  (${formatNumber(osqfuPriceInETH.toNumber(), 4)} ETH)`}
      />

      <Metric
        label={<MetricLabel label="Implied Volatility" tooltipTitle={Tooltips.ImplVol} />}
        value={`${formatNumber(impliedVolPercent)}%`}
      />

      <Metric
        label={<MetricLabel label="Reference Volatility" tooltipTitle={Tooltips.osqfuRefVol} />}
        value={`${formatNumber(osqfuRefVol)}%`}
      />

      <Metric
        label={<MetricLabel label="Current Implied Premium" tooltipTitle={Tooltips.CurrentImplFunding} />}
        value={currentImpliedPremium}
      />
    </Box>
  )
}

export default SquFuryInfo
