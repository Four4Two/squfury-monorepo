import { gql } from '@apollo/client'

export const CRAB_TX_QUERY = gql`
  query crabAuctions {
    crabAuctions(orderBy: timestamp, orderDirection: desc) {
      id
      owner
      squfuryAmount
      ethAmount
      isSellingSquFury
      isHedgingOnUniswap
      timestamp
    }
  }
`
export default CRAB_TX_QUERY
