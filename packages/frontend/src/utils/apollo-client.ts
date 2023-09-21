import { ApolloClient, InMemoryCache, split, HttpLink, ApolloLink, from } from '@apollo/client'
import { getMainDefinition } from '@apollo/client/utilities'
import { WebSocketLink } from '@apollo/client/link/ws'
import { SITE_EVENTS, trackEvent } from './amplitude'
import * as Fathom from 'fathom-client'

const httpLinkMN = new HttpLink({
  uri: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3',
})

const httpLinkRP = new HttpLink({
  uri: 'https://api.thegraph.com/subgraphs/name/kmkoushik/uniswap-v3-ropsten',
})

const httpLinkGL = new HttpLink({
  uri: 'https://api.thegraph.com/subgraphs/name/kmkoushik/uniswap-v3-goerli',
})

const httpLinkRPSquFury = new HttpLink({
  uri: 'https://api.thegraph.com/subgraphs/name/opynfinance/squfury-ropsten',
})

const httpLinkMNSquFury = new HttpLink({
  uri: 'https://api.thegraph.com/subgraphs/name/opynfinance/squfury',
  fetch: async (...pl) => {
    const [_, options] = pl
    if (options?.body) {
      const body = JSON.parse(options.body.toString())
      const startTime = new Date().getTime()
      const res = await fetch(...pl)
      const elapsed = new Date().getTime() - startTime
      trackEvent(SITE_EVENTS.SUBGRAPH_QUERY_LOADED, { query: body.operationName, time: elapsed })
      Fathom.trackGoal('HPHEK6AI', elapsed) //Track in fathom
      return res
    }

    return fetch(...pl)
  },
})

const httpLinkGLSquFury = new HttpLink({
  uri: 'https://api.thegraph.com/subgraphs/name/haythem96/squeeth-temp-subgraph',
})

const wsLinkRP =
  typeof window !== 'undefined'
    ? new WebSocketLink({
        uri: 'wss://api.thegraph.com/subgraphs/name/kmkoushik/uniswap-v3-ropsten',
        options: {
          reconnect: false,
        },
      })
    : null

const wsLinkMN =
  typeof window !== 'undefined'
    ? new WebSocketLink({
        uri: 'wss://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3',
        options: {
          reconnect: false,
        },
      })
    : null

const wsLinkGL =
  typeof window !== 'undefined'
    ? new WebSocketLink({
        uri: 'wss://api.thegraph.com/subgraphs/name/kmkoushik/uniswap-v3-goerli',
        options: {
          reconnect: false,
        },
      })
    : null

const wsLinkRPSquFury =
  typeof window !== 'undefined'
    ? new WebSocketLink({
        uri: 'wss://api.thegraph.com/subgraphs/name/opynfinance/squfury-ropsten',
        options: {
          reconnect: false,
        },
      })
    : null

const wsLinkMNSquFury =
  typeof window !== 'undefined'
    ? new WebSocketLink({
        uri: 'wss://api.thegraph.com/subgraphs/name/opynfinance/squfury',
        options: {
          reconnect: false,
        },
      })
    : null

const wsLinkGLSquFury =
  typeof window !== 'undefined'
    ? new WebSocketLink({
        uri: 'wss://api.thegraph.com/subgraphs/name/haythem96/squeeth-temp-subgraph',
        options: {
          reconnect: false,
        },
      })
    : null

const splitLink = (wsLink: any, httpLink: any) => {
  return split(
    ({ query }) => {
      const definition = getMainDefinition(query)
      return definition.kind === 'OperationDefinition' && definition.operation === 'subscription'
    },
    wsLink,
    httpLink,
  )
}

const mainnet = new ApolloClient({
  link: typeof window !== 'undefined' ? splitLink(wsLinkMN, httpLinkMN) : undefined,
  cache: new InMemoryCache(),
})

const ropsten = new ApolloClient({
  link: typeof window !== 'undefined' ? splitLink(wsLinkRP, httpLinkRP) : undefined,
  cache: new InMemoryCache(),
})

const goerli = new ApolloClient({
  link: typeof window !== 'undefined' ? splitLink(wsLinkGL, httpLinkGL) : undefined,
  cache: new InMemoryCache(),
})

export const uniswapClient = {
  1: mainnet,
  3: ropsten,
  5: goerli,
  31337: mainnet, // Can be replaced with local graph node if needed
  421611: mainnet, // Should be replaced with arbitrum subgraph
}

const squfuryMainnet = new ApolloClient({
  link: typeof window !== 'undefined' ? ApolloLink.from([splitLink(wsLinkMNSquFury, httpLinkMNSquFury)]) : undefined,
  cache: new InMemoryCache(),
})

const squfuryRopsten = new ApolloClient({
  link: typeof window !== 'undefined' ? splitLink(wsLinkRPSquFury, httpLinkRPSquFury) : undefined,
  cache: new InMemoryCache(),
})

const squfuryGoerli = new ApolloClient({
  link: typeof window !== 'undefined' ? splitLink(wsLinkGLSquFury, httpLinkGLSquFury) : undefined,
  cache: new InMemoryCache(),
})

export const squfuryClient = {
  1: squfuryMainnet,
  3: squfuryRopsten,
  5: squfuryGoerli,
  31337: squfuryMainnet, // Can be replaced with local graph node if needed
  421611: squfuryMainnet, // Should be replaced with arbitrum subgraph
}
