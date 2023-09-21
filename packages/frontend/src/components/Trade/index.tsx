import React from 'react'
import { Box, BoxProps } from '@material-ui/core'
import { useAtom, useAtomValue } from 'jotai'
import { useResetAtom } from 'jotai/utils'

import { isTransactionFirstStepAtom, transactionDataAtom, transactionLoadingAtom } from '@state/wallet/atoms'
import { ethTradeAmountAtom, openPositionAtom, sqfuTradeAmountAtom, tradeTypeAtom } from '@state/trade/atoms'
import { SquFuryTabNew, SquFuryTabsNew } from '@components/Tabs'
import { TradeType } from 'src/types'
import Long from './Long'
import Short from './Short'

const Trade: React.FC<BoxProps> = (props) => {
  const resetEthTradeAmount = useResetAtom(ethTradeAmountAtom)
  const resetSqfuTradeAmount = useResetAtom(sqfuTradeAmountAtom)
  const tradeType = useAtomValue(tradeTypeAtom)
  const [openPosition, setOpenPosition] = useAtom(openPositionAtom)
  const resetTransactionData = useResetAtom(transactionDataAtom)
  const transactionInProgress = useAtomValue(transactionLoadingAtom)
  const isTxFirstStep = useAtomValue(isTransactionFirstStepAtom)

  return (
    <Box id="trade-card" {...props}>
      <SquFuryTabsNew
        value={openPosition}
        onChange={(evt, val) => {
          setOpenPosition(val)

          if (!transactionInProgress || !isTxFirstStep) {
            resetEthTradeAmount()
            resetSqfuTradeAmount()
            resetTransactionData()
          }
        }}
        aria-label="simple tabs example"
        centered
        variant="fullWidth"
      >
        <SquFuryTabNew label="Open" id="open-btn" />
        <SquFuryTabNew label="Close" id="close-btn" />
      </SquFuryTabsNew>

      <Box marginTop="32px">
        {tradeType === TradeType.LONG ? <Long open={openPosition === 0} /> : <Short open={openPosition === 0} />}
      </Box>
    </Box>
  )
}

export default Trade
