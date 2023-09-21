import type { NextApiRequest, NextApiResponse } from 'next'
import { getCoingeckoETHPricesBetweenTimestamps as getETHPricesBetweenTs } from '@utils/ethPriceCharts'
import { getLiveVolMap, getSquFuryChartWithFunding, getVolForTimestampOrDefault, getVolMap } from '@utils/pricer'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const collatRatio = Number(req.query.collatRatio)
  const fromTs = Number(req.query.fromTs)
  const toTs = Number(req.query.toTs)
  const volMultiplier = Number(req.query.volMultiplier)
  const oneDay = 24 * 60 * 60 * 1000
  const days = (toTs - fromTs) / oneDay

  try {
    const ethPrices = await getETHPricesBetweenTs(fromTs, toTs)

    const ethSquFuryPNLSeriesPromise = getETHSquFuryPNLCompounding(ethPrices, volMultiplier, days)
    const squfurySeriesPromise = getSquFuryChartWithFunding(ethPrices, volMultiplier, collatRatio)

    const [ethSquFuryPNLSeries, squfurySeries] = await Promise.all([ethSquFuryPNLSeriesPromise, squfurySeriesPromise])
    const longEthPNL = ethSquFuryPNLSeries.ethPNL.map(({ time, longPNL }) => {
      return { time, value: longPNL }
    })
    const longSeries = ethSquFuryPNLSeries.squfuryPNL.map(({ time, longPNL }) => {
      return { time, value: longPNL }
    })
    const squfuryIsLive = ethSquFuryPNLSeries.squfuryPNL.map(({ isLive }) => {
      return isLive
    })
    const positionSizeSeries = squfurySeries.series.map(({ time, positionSize }) => {
      return { time, value: positionSize * 100 }
    })

    const response = { longEthPNL, longSeries, positionSizeSeries, squfuryIsLive }

    res.status(200).send(response)
  } catch (error: any) {
    console.log({ error: error.message })
    res.status(400).json({ error: 'There was an error fetching the data' })
  }
}

async function getETHSquFuryPNLCompounding(
  ethPrices: { time: number; value: number }[],
  volMultiplier = 1.2,
  days = 365,
) {
  const timestamps = ethPrices.map(({ time }) => time)

  let cumulativeSquFuryLongReturn = 0
  let cumulativeSquFuryCrabReturn = 1
  const volsMap = await getVolMap()
  const liveVolsMap = await getLiveVolMap()

  const annualVolData = await Promise.all(
    timestamps.map(async (timestamp, index) => {
      const { value: price, time } = ethPrices[index > 0 ? index : 0]
      const utcDate = new Date(timestamp * 1000).toISOString().split('T')[0]
      let annualVol = liveVolsMap[utcDate]
      let isLive = true
      if (!annualVol) {
        annualVol = await getVolForTimestampOrDefault(volsMap, time, price)
        isLive = false
      }

      return { annualVol, isLive }
    }),
  )

  let cumulativeEthLongShortReturn = 0

  const ethChartData = ethPrices.map((ethItem, index) => {
    const { value: price, time } = ethItem
    const preEthPrice = ethPrices[index > 0 ? index - 1 : 0].value
    cumulativeEthLongShortReturn += Math.log(price / preEthPrice)

    const longPNL = Math.round((Math.exp(cumulativeEthLongShortReturn) - 1) * 10000) / 100
    const shortPNL = Math.round((Math.exp(-cumulativeEthLongShortReturn) - 1) * 10000) / 100
    return { shortPNL, longPNL, time }
  })

  const squfuryChartData = annualVolData.map((item, index) => {
    const { annualVol, isLive } = item
    const { value: price, time } = ethPrices[index > 0 ? index : 0]

    const fundingPeriodMultiplier = days > 90 ? 365 : days > 1 ? 365 * 24 : 356 * 24 * 12

    let vol = annualVol * volMultiplier
    const preEthPrice = ethPrices[index > 0 ? index - 1 : 0].value
    let fundingCost = index === 0 ? 0 : (vol / Math.sqrt(fundingPeriodMultiplier)) ** 2
    cumulativeSquFuryLongReturn += 2 * Math.log(price / preEthPrice) + Math.log(price / preEthPrice) ** 2 - fundingCost
    // crab return
    const crabVolMultiplier = 0.9
    vol = annualVol * crabVolMultiplier
    fundingCost = index === 0 ? 0 : (vol / Math.sqrt(fundingPeriodMultiplier)) ** 2
    const simR = price / preEthPrice - 1
    cumulativeSquFuryCrabReturn *= 1 + -(simR ** 2) + fundingCost
    const longPNL = Math.round((Math.exp(cumulativeSquFuryLongReturn) - 1) * 10000) / 100
    const shortPNL = Math.round(Math.log(cumulativeSquFuryCrabReturn) * 10000) / 100

    return { shortPNL, longPNL, time, isLive }
  })

  return { ethPNL: ethChartData, squfuryPNL: squfuryChartData }
}
