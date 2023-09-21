import { useState } from 'react'
import { useQuery, NetworkStatus } from '@apollo/client'
import { BIG_ZERO } from '@constants/index'

import VAULT_HISTORY_QUERY, { VAULT_HISTORY_SUBSCRIPTION } from '../queries/squfury/vaultHistoryQuery'
import {
  VaultHistory,
  VaultHistoryVariables,
  VaultHistory_vaultHistories,
} from '../queries/squfury/__generated__/VaultHistory'
import { squfuryClient } from '@utils/apollo-client'
import { Action } from '@constants/index'
import { toTokenAmount } from '@utils/calculations'
import { addressAtom, networkIdAtom } from 'src/state/wallet/atoms'
import { useAtomValue } from 'jotai'
import { usePrevious } from 'react-use'
import { vaultHistoryUpdatingAtom } from 'src/state/positions/atoms'
import { useUpdateAtom } from 'jotai/utils'
import useAppEffect from './useAppEffect'
import useAppMemo from './useAppMemo'

export const useVaultHistoryQuery = (vaultId: number, poll = false) => {
  const address = useAtomValue(addressAtom)
  const networkId = useAtomValue(networkIdAtom)
  const [vaultHistories, setVaultHistories] = useState<VaultHistory_vaultHistories[]>([])
  const setVaultHistoryUpdating = useUpdateAtom(vaultHistoryUpdatingAtom)

  const { data, loading, refetch, subscribeToMore, startPolling, stopPolling, networkStatus } = useQuery<
    VaultHistory,
    VaultHistoryVariables
  >(VAULT_HISTORY_QUERY, {
    client: squfuryClient[networkId],
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
    variables: {
      vaultId: vaultId,
    },
  })
  const vaultHistory = data?.vaultHistories
  const prevVaultHistory = usePrevious(vaultHistory)

  useAppEffect(() => {
    if (vaultHistory && vaultHistory.length > 0) {
      setVaultHistories(vaultHistory)
    }
  }, [vaultHistory])

  useAppEffect(() => {
    if (poll && prevVaultHistory?.length === vaultHistory?.length) {
      startPolling(500)
    } else {
      setVaultHistoryUpdating(false)
      stopPolling()
    }
  }, [poll, prevVaultHistory, startPolling, stopPolling, vaultHistory, setVaultHistoryUpdating])

  useAppEffect(() => {
    subscribeToMore({
      document: VAULT_HISTORY_SUBSCRIPTION,
      variables: {
        vaultId: vaultId,
      },
      updateQuery(prev, { subscriptionData }) {
        if (!subscriptionData.data || subscriptionData.data.vaultHistories.length === data?.vaultHistories.length)
          return prev
        const newVaultsHistories = subscriptionData.data.vaultHistories
        return { vaultHistories: newVaultsHistories }
      },
    })
  }, [address, vaultId, subscribeToMore, data?.vaultHistories.length])

  return {
    vaultHistory: vaultHistories,
    loading: loading || poll || networkStatus === NetworkStatus.refetch,
    refetch,
  }
}

export const useVaultHistory = (vaultId: number) => {
  const { vaultHistory } = useVaultHistoryQuery(vaultId)

  //accumulated four actions, mintedSquFury doesn't take minted squfury sold into account
  //only consider first valid vault
  //mintedSquFury + openShortSquFury = shortAmount in the vault
  const { mintedSquFury, burnedSquFury, openShortSquFury, closeShortSquFury } = useAppMemo(
    () =>
      vaultHistory?.reduce(
        (acc, s) => {
          if (s.action === Action.MINT) {
            acc.mintedSquFury = acc.mintedSquFury.plus(s.oSqfuAmount)
          } else if (s.action === Action.BURN) {
            acc.mintedSquFury = acc.mintedSquFury.minus(s.oSqfuAmount)
            acc.burnedSquFury = acc.burnedSquFury.plus(s.oSqfuAmount)
          } else if (s.action === Action.OPEN_SHORT) {
            acc.openShortSquFury = acc.openShortSquFury.plus(s.oSqfuAmount)
          } else if (s.action === Action.CLOSE_SHORT) {
            acc.closeShortSquFury = acc.closeShortSquFury.plus(s.oSqfuAmount)
            // users fully close short position
            if (
              acc.closeShortSquFury.isEqualTo(acc.openShortSquFury.plus(acc.mintedSquFury)) &&
              !acc.closeShortSquFury.isEqualTo(0)
            ) {
              acc.mintedSquFury = BIG_ZERO
              acc.burnedSquFury = BIG_ZERO
              acc.openShortSquFury = BIG_ZERO
              acc.closeShortSquFury = BIG_ZERO
            } else {
              acc.openShortSquFury = acc.openShortSquFury.minus(s.oSqfuAmount)
            }
          }
          //if user burn all their osqufury, reset all values
          if (acc.mintedSquFury.isLessThanOrEqualTo(0)) {
            acc.mintedSquFury = BIG_ZERO
            acc.burnedSquFury = BIG_ZERO
          }
          //if user close all their short position with OPEN_SHORT/CLOSE_SHORT, reset all values
          if (acc.openShortSquFury.isLessThanOrEqualTo(0)) {
            acc.openShortSquFury = BIG_ZERO
            acc.closeShortSquFury = BIG_ZERO
          }

          return acc
        },
        {
          mintedSquFury: BIG_ZERO,
          burnedSquFury: BIG_ZERO,
          openShortSquFury: BIG_ZERO,
          closeShortSquFury: BIG_ZERO,
        },
      ) || {
        mintedSquFury: BIG_ZERO,
        burnedSquFury: BIG_ZERO,
        openShortSquFury: BIG_ZERO,
        closeShortSquFury: BIG_ZERO,
      },
    [vaultHistory],
  )
  // console.log(vaultHistory, toTokenAmount(mintedSquFury, 18).toString(), toTokenAmount(openShortSquFury, 18).toString())
  return {
    mintedSquFury: toTokenAmount(mintedSquFury, 18),
    burnedSquFury: toTokenAmount(burnedSquFury, 18),
    openShortSquFury: toTokenAmount(openShortSquFury, 18),
    closeShortSquFury: toTokenAmount(closeShortSquFury, 18),
    vaultHistory,
  }
}
