import { useQuery } from '@apollo/client'
import { useAtomValue } from 'jotai'

import { crabV2Auctions } from '../queries/squfury/__generated__/crabV2Auctions'
import CRAB_V2_AUCTION_QUERY from '../queries/squfury/crabV2AuctionQuery'
import { toTokenAmount } from '@utils/calculations'
import { WETH_DECIMALS, OSQUFURY_DECIMALS } from '../constants'
import { squfuryClient } from '@utils/apollo-client'
import { networkIdAtom } from 'src/state/wallet/atoms'
import { visibleStrategyHedgesAtom } from '@state/crab/atoms'

export const useCrabStrategyV2TxHistory = () => {
  const networkId = useAtomValue(networkIdAtom)
  const visibleHedges = useAtomValue(visibleStrategyHedgesAtom)
  const { data, loading } = useQuery<crabV2Auctions>(CRAB_V2_AUCTION_QUERY, {
    fetchPolicy: 'cache-and-network',
    client: squfuryClient[networkId],
  })

  const uiData = data?.hedgeOTCs!.map((tx) => {
    const oSquFuryAmount = toTokenAmount(tx.quantity, OSQUFURY_DECIMALS)
    const clearingPrice = toTokenAmount(tx.clearingPrice, WETH_DECIMALS)
    const ethAmount = oSquFuryAmount.times(clearingPrice)

    return {
      ...tx,
      ethAmount,
      oSquFuryAmount,
    }
  })

  return {
    loading,
    data: uiData?.slice(0, visibleHedges),
    showMore: (uiData ?? []).length > visibleHedges,
  }
}
