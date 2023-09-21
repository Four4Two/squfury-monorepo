import { useQuery } from '@apollo/client'
import { useAtomValue } from 'jotai'

import { crabAuctions } from '../queries/squfury/__generated__/crabAuctions'
import CRAB_AUCTION_QUERY from '../queries/squfury/crabAuctionQuery'
import { toTokenAmount } from '@utils/calculations'
import { WETH_DECIMALS, OSQUFURY_DECIMALS } from '../constants'
import { squfuryClient } from '@utils/apollo-client'
import { networkIdAtom } from 'src/state/wallet/atoms'

export const useCrabStrategyTxHistory = () => {
  const networkId = useAtomValue(networkIdAtom)
  const { data, loading } = useQuery<crabAuctions>(CRAB_AUCTION_QUERY, {
    fetchPolicy: 'cache-and-network',
    client: squfuryClient[networkId],
  })

  const uiData = data?.crabAuctions.map((tx) => {
    const ethAmount = toTokenAmount(tx.ethAmount, WETH_DECIMALS)
    const oSquFuryAmount = toTokenAmount(tx.squfuryAmount, OSQUFURY_DECIMALS)

    return {
      ...tx,
      ethAmount,
      oSquFuryAmount,
    }
  })

  return {
    loading,
    data: uiData,
  }
}
