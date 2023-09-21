import { CircularProgress, createStyles, makeStyles, Typography, Box, Collapse, Tooltip } from '@material-ui/core'
import BigNumber from 'bignumber.js'
import { useAtom, useAtomValue } from 'jotai'
import { useResetAtom, useUpdateAtom } from 'jotai/utils'
import React, { useState } from 'react'
import debounce from 'lodash/debounce'

import { PrimaryButtonNew } from '@components/Button'
import { InputToken } from '@components/InputNew'
import { UniswapIframe } from '@components/Modal/UniswapIframe'
import { TradeSettings } from '@components/TradeSettings'
import Alert from '@components/Alert'
import { useUserAllowance } from '@hooks/contracts/useAllowance'
import useAppCallback from '@hooks/useAppCallback'
import useAppEffect from '@hooks/useAppEffect'
import useAppMemo from '@hooks/useAppMemo'
import { useETHPrice } from '@hooks/useETHPrice'
import { useOSQFUPrice } from '@hooks/useOSQFUPrice'
import { toTokenAmount } from '@utils/calculations'
import { currentImpliedFundingAtom, dailyHistoricalFundingAtom } from '@state/controller/atoms'
import { addressesAtom, isShortAtom } from '@state/positions/atoms'
import { useComputeSwaps, useShortDebt } from '@state/positions/hooks'
import {
  useAutoRoutedBuyAndRefund,
  useAutoRoutedSell,
  useAutoRoutedGetSellQuote,
  useGetBuyQuote,
  useGetBuyQuoteForETH,
  useGetSellQuoteForETH,
} from '@state/squfuryPool/hooks'
import {
  confirmedAmountAtom,
  ethTradeAmountAtom,
  inputQuoteLoadingAtom,
  quoteAtom,
  slippageAmountAtom,
  sqfuTradeAmountAtom,
  tradeCompletedAtom,
  tradeSuccessAtom,
} from '@state/trade/atoms'
import { connectedWalletAtom, isTransactionFirstStepAtom, supportedNetworkAtom } from '@state/wallet/atoms'
import { useSelectWallet, useTransactionStatus, useWalletBalance } from '@state/wallet/hooks'
import { BIG_ZERO } from '@constants/index'
import { formatCurrency, formatNumber } from '@utils/formatter'
import ethLogo from 'public/images/eth-logo.svg'
import osqfuLogo from 'public/images/osqfu-logo.svg'
import Cancelled from '../Cancelled'
import Confirmed, { ConfirmType } from '../Confirmed'
import Metric from '@components/Metric'
import RestrictionInfo from '@components/RestrictionInfo'
import { useRestrictUser } from '@context/restrict-user'
import { Tooltips } from '@constants/enums'
import InfoIcon from '@material-ui/icons/InfoOutlined'

const useStyles = makeStyles((theme) =>
  createStyles({
    header: {
      color: theme.palette.primary.main,
    },
    title: {
      fontSize: '20px',
      fontWeight: 700,
      letterSpacing: '-0.01em',
      marginBottom: '24px',
    },
    sectionTitle: {
      fontSize: '20px',
      fontWeight: 700,
      letterSpacing: '-0.01em',
      marginBottom: '16px',
    },
    body: {
      padding: theme.spacing(2, 12),
      margin: 'auto',
      display: 'flex',
      justifyContent: 'space-around',
    },
    subHeading: {
      color: theme.palette.text.secondary,
    },
    thirdHeading: {
      marginTop: theme.spacing(2),
      paddingLeft: theme.spacing(1),
      paddingRight: theme.spacing(1),
    },
    explainer: {
      marginTop: theme.spacing(2),
      paddingLeft: theme.spacing(1),
      paddingRight: theme.spacing(1),
      marginLeft: theme.spacing(1),
      width: '200px',
      justifyContent: 'left',
    },
    caption: {
      marginTop: theme.spacing(1),
      fontSize: '13px',
    },
    divider: {
      margin: theme.spacing(2, 0),
      width: '300px',
      marginLeft: 'auto',
      marginRight: 'auto',
    },
    details: {
      marginTop: theme.spacing(4),
      width: '65%',
    },
    buyCard: {
      marginTop: theme.spacing(4),
      marginLeft: theme.spacing(2),
    },
    cardTitle: {
      color: theme.palette.primary.main,
      marginTop: theme.spacing(4),
    },
    cardSubTxt: {
      color: theme.palette.text.secondary,
      lineHeight: '1.75rem',
      fontSize: '16px',
      width: '90%',
    },
    payoff: {
      color: theme.palette.text.secondary,
      lineHeight: '1.75rem',
      fontSize: '16px',
    },
    cardDetail: {
      color: theme.palette.text.secondary,
      lineHeight: '1.75rem',
      fontSize: '16px',
      marginTop: theme.spacing(4),
    },
    amountInput: {
      backgroundColor: theme.palette.success.main,
      '&:hover': {
        backgroundColor: theme.palette.success.dark,
      },
    },
    innerCard: {
      textAlign: 'center',
      padding: theme.spacing(2),
      paddingBottom: theme.spacing(8),
      background: theme.palette.background.default,
      border: `1px solid ${theme.palette.background.stone}`,
    },
    expand: {
      transform: 'rotate(270deg)',
      color: theme.palette.primary.main,
      transition: theme.transitions.create('transform', {
        duration: theme.transitions.duration.shortest,
      }),
      marginTop: theme.spacing(6),
    },
    expandOpen: {
      transform: 'rotate(180deg)',
      color: theme.palette.primary.main,
    },
    dialog: {
      padding: theme.spacing(2),
    },
    dialogHeader: {
      display: 'flex',
      alignItems: 'center',
    },
    dialogIcon: {
      marginRight: theme.spacing(1),
      color: theme.palette.warning.main,
    },
    txItem: {
      marginTop: theme.spacing(1),
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    squfuryExp: {
      display: 'flex',
      justifyContent: 'space-between',
      borderRadius: theme.spacing(1),
      padding: theme.spacing(1.5),
      width: '300px',
      marginLeft: 'auto',
      marginRight: 'auto',
      marginTop: theme.spacing(2),
      textAlign: 'left',
      backgroundColor: theme.palette.background.stone,
    },
    squfuryExpTxt: {
      fontSize: '20px',
    },
    closePosition: {
      display: 'flex',
      justifyContent: 'space-between',
      padding: theme.spacing(0, 1),
    },
    closeBtn: {
      color: theme.palette.error.main,
    },
    paper: {
      backgroundColor: theme.palette.background.paper,
      boxShadow: theme.shadows[5],
      borderRadius: theme.spacing(1),
      width: '350px',
      textAlign: 'center',
      paddingBottom: theme.spacing(2),
    },
    modal: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonDiv: {
      position: 'sticky',
      bottom: '0',
      backgroundColor: theme.palette.background.default,
      zIndex: 1500,
    },
    hint: {
      display: 'flex',
      alignItems: 'center',
    },
    arrowIcon: {
      marginLeft: '4px',
      marginRight: '4px',
      fontSize: '20px',
    },
    hintTextContainer: {
      display: 'flex',
    },
    hintTitleText: {
      marginRight: '.5em',
    },
    linkHover: {
      '&:hover': {
        opacity: 0.7,
      },
    },
    anchor: {
      color: '#FF007A',
      fontSize: '16px',
    },
    settingsContainer: {
      display: 'flex',
      justify: 'space-between',
      alignItems: 'center',
    },
    settingsButton: {
      marginTop: theme.spacing(2),
      marginLeft: theme.spacing(10),
      justifyContent: 'right',
      alignSelf: 'center',
    },
    displayBlock: {
      display: 'block',
    },
    displayNone: {
      display: 'none',
    },
    lightStoneBackground: {
      backgroundColor: theme.palette.background.lightStone,
    },
    txStatus: {
      marginTop: theme.spacing(4),
    },
    labelContainer: {
      display: 'flex',
      alignItems: 'center',
      color: 'rgba(255, 255, 255, 0.5)',
    },
    label: {
      fontSize: '15px',
      fontWeight: 500,
      width: 'max-content',
    },
    infoIcon: {
      fontSize: '15px',
      marginLeft: theme.spacing(0.5),
    },
  }),
)

const Label: React.FC<{ label: string; tooltipTitle: string }> = ({ label, tooltipTitle }) => {
  const classes = useStyles()

  return (
    <div className={classes.labelContainer}>
      <Typography className={classes.label}>{label}</Typography>
      <Tooltip title={tooltipTitle}>
        <InfoIcon fontSize="small" className={classes.infoIcon} />
      </Tooltip>
    </div>
  )
}

const FUNDING_MOVE_THRESHOLD = 1.3

const OpenLong: React.FC<BuyProps> = ({ activeStep = 0, showTitle }) => {
  const [buyLoading, setBuyLoading] = useState(false)

  const getBuyQuoteForETH = useGetBuyQuoteForETH()
  const getBuyQuote = useGetBuyQuote()
  const { data } = useWalletBalance()
  const balance = Number(toTokenAmount(data ?? BIG_ZERO, 18).toFixed(4))

  const classes = useStyles()
  const {
    cancelled,
    confirmed,
    loading: transactionInProgress,
    transactionData,
    resetTxCancelled,
    resetTransactionData,
  } = useTransactionStatus()
  // const buyAndRefund = useBuyAndRefund()
  const buyAndRefund = useAutoRoutedBuyAndRefund()
  const [confirmedAmount, setConfirmedAmount] = useAtom(confirmedAmountAtom)
  const [inputQuoteLoading, setInputQuoteLoading] = useAtom(inputQuoteLoadingAtom)
  const setTradeSuccess = useUpdateAtom(tradeSuccessAtom)
  const [slippageAmount, setSlippage] = useAtom(slippageAmountAtom)
  const ethPrice = useETHPrice()
  const { loading: loadingOSQFUPrice, data: osqfuPrice } = useOSQFUPrice()
  const { isRestricted, isWithdrawAllowed } = useRestrictUser()

  const { squfuryAmount } = useComputeSwaps()

  const connected = useAtomValue(connectedWalletAtom)
  const supportedNetwork = useAtomValue(supportedNetworkAtom)
  const isShort = useAtomValue(isShortAtom)
  const selectWallet = useSelectWallet()
  const dailyHistoricalFunding = useAtomValue(dailyHistoricalFundingAtom)
  const currentImpliedFunding = useAtomValue(currentImpliedFundingAtom)

  const [ethTradeAmount, setEthTradeAmount] = useAtom(ethTradeAmountAtom)
  const [sqfuTradeAmount, setSqfuTradeAmount] = useAtom(sqfuTradeAmountAtom)

  const [quote, setQuote] = useAtom(quoteAtom)

  const resetEthTradeAmount = useResetAtom(ethTradeAmountAtom)
  const resetSqfuTradeAmount = useResetAtom(sqfuTradeAmountAtom)
  const resetQuote = useResetAtom(quoteAtom)
  const setTradeCompleted = useUpdateAtom(tradeCompletedAtom)

  const buyQuoteForETHHandler = useAppCallback(
    (ethAmount, slippage) => {
      if (parseFloat(ethAmount) === 0) {
        resetQuote()
        resetSqfuTradeAmount()
        return
      }
      setInputQuoteLoading(true)

      return getBuyQuoteForETH(new BigNumber(ethAmount), slippage).then((quoteVal) => {
        if (quoteVal) {
          setQuote(quoteVal)

          setSqfuTradeAmount(quoteVal.amountOut.toString())
          setConfirmedAmount(quoteVal.amountOut.toFixed(6).toString())
          setInputQuoteLoading(false)
        }
      })
    },
    [
      getBuyQuoteForETH,
      resetQuote,
      resetSqfuTradeAmount,
      setInputQuoteLoading,
      setQuote,
      setSqfuTradeAmount,
      setConfirmedAmount,
    ],
  )

  const debouncedBuyQuoteForETHHandler = useAppMemo(() => debounce(buyQuoteForETHHandler, 500), [buyQuoteForETHHandler])

  useAppEffect(() => {
    debouncedBuyQuoteForETHHandler(ethTradeAmount, slippageAmount)
  }, [ethTradeAmount, slippageAmount, debouncedBuyQuoteForETHHandler])

  const handleEthChange = useAppCallback(
    (value: string) => {
      setEthTradeAmount(value)
    },
    [setEthTradeAmount],
  )

  const buyQuoteHandler = useAppCallback(
    (sqfuAmount, slippage) => {
      setInputQuoteLoading(true)

      return getBuyQuote(new BigNumber(sqfuAmount), slippage).then((quoteVal) => {
        setEthTradeAmount(quoteVal.amountIn.toString())
        setInputQuoteLoading(false)
      })
    },
    [setInputQuoteLoading, getBuyQuote, setEthTradeAmount],
  )

  const debouncedBuyQuoteHandler = useAppMemo(() => debounce(buyQuoteHandler, 500), [buyQuoteHandler])

  const handleSqfuChange = useAppCallback(
    (value: string) => {
      setSqfuTradeAmount(value)
      debouncedBuyQuoteHandler(value, slippageAmount)
    },
    [slippageAmount, setSqfuTradeAmount, debouncedBuyQuoteHandler],
  )

  let openError: string | undefined
  // let closeError: string | undefined
  let existingShortError: string | undefined
  let priceImpactWarning: string | undefined
  let highVolError: string | undefined

  if (connected) {
    if (new BigNumber(ethTradeAmount).gt(balance)) {
      openError = 'Insufficient ETH balance'
    }
    if (isShort) {
      existingShortError = 'Close your short position to open a long'
    }
    if (new BigNumber(quote.priceImpact).gt(3)) {
      priceImpactWarning = 'High Price Impact'
    }

    if (
      currentImpliedFunding >= FUNDING_MOVE_THRESHOLD * dailyHistoricalFunding.funding &&
      Number(ethTradeAmount) > 0
    ) {
      const fundingPercent = (currentImpliedFunding / dailyHistoricalFunding.funding - 1) * 100
      highVolError = `Premiums are ${fundingPercent.toFixed(0)}% above yesterday. Consider buying later`
    }
  }

  const longOpenPriceImpactErrorState = priceImpactWarning && !buyLoading && !openError && !isShort

  const error = existingShortError
    ? existingShortError
    : priceImpactWarning
    ? priceImpactWarning
    : highVolError
    ? highVolError
    : ''

  useAppEffect(() => {
    if (transactionInProgress) {
      setBuyLoading(false)
    }
  }, [transactionInProgress])

  const transact = useAppCallback(async () => {
    setBuyLoading(true)
    try {
      await buyAndRefund(new BigNumber(ethTradeAmount), () => {
        setTradeSuccess(true)
        setTradeCompleted(true)

        resetEthTradeAmount()
        resetSqfuTradeAmount()
      })
    } catch (e) {
      console.log(e)
      setBuyLoading(false)
    }
  }, [buyAndRefund, ethTradeAmount, resetEthTradeAmount, resetSqfuTradeAmount, setTradeCompleted, setTradeSuccess])

  const squfuryExposure = osqfuPrice.times(sqfuTradeAmount).toNumber()
  const slippageAmountValue = isNaN(slippageAmount.toNumber()) ? 0 : slippageAmount.toNumber()
  const priceImpact = isNaN(Number(quote.priceImpact)) ? 0 : Number(quote.priceImpact)
  const priceImpactColor = priceImpact > 3 ? 'error' : undefined

  return (
    <div id="open-long-card">
      {confirmed ? (
        <div className={classes.txStatus}>
          <Confirmed
            confirmationMessage={`Bought ${confirmedAmount} SquFury`}
            txnHash={transactionData?.hash ?? ''}
            confirmType={ConfirmType.TRADE}
          />
          <div className={classes.buttonDiv}>
            <PrimaryButtonNew
              fullWidth
              id="open-long-close-btn"
              variant="contained"
              onClick={() => {
                resetTransactionData()
              }}
            >
              {'Close'}
            </PrimaryButtonNew>
          </div>
        </div>
      ) : cancelled ? (
        <div className={classes.txStatus}>
          <Cancelled txnHash={transactionData?.hash ?? ''} />
          <div className={classes.buttonDiv}>
            <PrimaryButtonNew
              fullWidth
              variant="contained"
              onClick={() => {
                resetTransactionData()
                resetTxCancelled()
              }}
            >
              {'Close'}
            </PrimaryButtonNew>
          </div>
        </div>
      ) : (
        <div>
          {activeStep === 0 ? (
            <>
              {showTitle && (
                <Typography variant="h4" className={classes.title}>
                  Pay ETH to buy oSQFU
                </Typography>
              )}

              <Box display="flex" flexDirection="column" gridGap="16px">
                <InputToken
                  id="open-long-eth-input"
                  value={ethTradeAmount}
                  onInputChange={handleEthChange}
                  balance={new BigNumber(balance)}
                  logo={ethLogo}
                  symbol="ETH"
                  usdPrice={ethPrice}
                  onBalanceClick={() => handleEthChange(balance.toString())}
                  error={!!openError}
                  helperText={openError}
                />
                <InputToken
                  id="open-long-osqfu-input"
                  value={sqfuTradeAmount}
                  onInputChange={handleSqfuChange}
                  balance={squfuryAmount}
                  logo={osqfuLogo}
                  symbol="oSQFU"
                  usdPrice={osqfuPrice}
                  showMaxAction={false}
                />
              </Box>

              <Collapse in={!!error}>
                <Alert severity="error" marginTop="24px">
                  {error}
                </Alert>
              </Collapse>

              <Box
                display="flex"
                alignItems="center"
                justifyContent="space-between"
                flexWrap="wrap"
                gridGap="12px"
                marginTop="24px"
              >
                <Metric
                  label="Slippage"
                  value={formatNumber(slippageAmountValue) + '%'}
                  isSmall
                  flexDirection="row"
                  justifyContent="space-between"
                  gridGap="12px"
                />

                <Box display="flex" alignItems="center" gridGap="12px" flex="1">
                  <Metric
                    label="Price Impact"
                    value={formatNumber(priceImpact) + '%'}
                    textColor={priceImpactColor}
                    isSmall
                    flexDirection="row"
                    justifyContent="space-between"
                    gridGap="12px"
                  />

                  <TradeSettings setSlippage={(amt) => setSlippage(amt)} slippage={slippageAmount} />
                </Box>
              </Box>

              <Box marginTop="24px">
                <Typography variant="h4" className={classes.sectionTitle}>
                  Projection
                </Typography>

                <Box display="flex" alignItems="center" flexWrap="wrap" gridGap="12px">
                  <Metric
                    label={<Label label="Value if ETH -50%" tooltipTitle={Tooltips.ETHDown50} />}
                    value={loadingOSQFUPrice ? 'loading...' : formatCurrency(Number(squfuryExposure * 0.25))}
                    isSmall
                  />
                  <Metric
                    label={<Label label="Value if ETH 2x" tooltipTitle={Tooltips.ETHUp2x} />}
                    value={loadingOSQFUPrice ? 'loading...' : formatCurrency(Number(squfuryExposure * 4))}
                    isSmall
                  />
                </Box>
              </Box>

              {isRestricted && <RestrictionInfo withdrawAllowed={isWithdrawAllowed} marginTop="24px" />}

              <Box marginTop="24px" className={classes.buttonDiv}>
                {isRestricted ? (
                  <PrimaryButtonNew
                    fullWidth
                    variant="contained"
                    onClick={selectWallet}
                    disabled={true}
                    id="open-long-restricted-btn"
                  >
                    {'Unavailable'}
                  </PrimaryButtonNew>
                ) : !connected ? (
                  <PrimaryButtonNew
                    fullWidth
                    variant="contained"
                    onClick={selectWallet}
                    disabled={!!buyLoading}
                    id="open-long-connect-wallet-btn"
                  >
                    {'Connect Wallet'}
                  </PrimaryButtonNew>
                ) : (
                  <PrimaryButtonNew
                    fullWidth
                    variant={longOpenPriceImpactErrorState || !!highVolError ? 'outlined' : 'contained'}
                    onClick={transact}
                    disabled={
                      !supportedNetwork ||
                      !!buyLoading ||
                      transactionInProgress ||
                      !!openError ||
                      !!existingShortError ||
                      sqfuTradeAmount === '0' ||
                      inputQuoteLoading
                    }
                    style={
                      longOpenPriceImpactErrorState || !!highVolError
                        ? { color: '#f5475c', backgroundColor: 'transparent', borderColor: '#f5475c' }
                        : {}
                    }
                    id="open-long-submit-tx-btn"
                  >
                    {!supportedNetwork ? (
                      'Unsupported Network'
                    ) : buyLoading || transactionInProgress || inputQuoteLoading ? (
                      <CircularProgress color="primary" size="1.5rem" />
                    ) : longOpenPriceImpactErrorState ? (
                      'Buy oSQFU Anyway'
                    ) : (
                      'Buy oSQFU'
                    )}
                  </PrimaryButtonNew>
                )}
              </Box>
            </>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', margin: '20px 0' }}>
              <UniswapIframe />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const CloseLong: React.FC<BuyProps> = () => {
  const [sellLoading, setSellLoading] = useState(false)
  const [hasJustApprovedSquFury, setHasJustApprovedSquFury] = useState(false)

  const classes = useStyles()
  const {
    cancelled,
    confirmed,
    loading: transactionInProgress,
    transactionData,
    resetTxCancelled,
    resetTransactionData,
  } = useTransactionStatus()
  const { swapRouter2, oSquFury } = useAtomValue(addressesAtom)
  const sell = useAutoRoutedSell()
  const getSellQuoteForETH = useGetSellQuoteForETH()
  const getSellQuote = useAutoRoutedGetSellQuote()
  const { data } = useWalletBalance()
  const balance = Number(toTokenAmount(data ?? BIG_ZERO, 18).toFixed(4))

  const [confirmedAmount, setConfirmedAmount] = useAtom(confirmedAmountAtom)
  const [inputQuoteLoading, setInputQuoteLoading] = useAtom(inputQuoteLoadingAtom)
  const [quote, setQuote] = useAtom(quoteAtom)
  const [ethTradeAmount, setEthTradeAmount] = useAtom(ethTradeAmountAtom)
  const [sqfuTradeAmount, setSqfuTradeAmount] = useAtom(sqfuTradeAmountAtom)
  const setTradeSuccess = useUpdateAtom(tradeSuccessAtom)
  const setTradeCompleted = useUpdateAtom(tradeCompletedAtom)
  const [slippageAmount, setSlippage] = useAtom(slippageAmountAtom)
  const ethPrice = useETHPrice()
  const { data: osqfuPrice } = useOSQFUPrice()
  const amount = useAppMemo(() => new BigNumber(sqfuTradeAmount), [sqfuTradeAmount])
  const { allowance: squfuryAllowance, approve: squfuryApprove } = useUserAllowance(oSquFury, swapRouter2)
  const [isTxFirstStep, setIsTxFirstStep] = useAtom(isTransactionFirstStepAtom)
  const { isRestricted, isWithdrawAllowed } = useRestrictUser()

  const supportedNetwork = useAtomValue(supportedNetworkAtom)
  const connected = useAtomValue(connectedWalletAtom)
  const selectWallet = useSelectWallet()
  const { squfuryAmount } = useComputeSwaps()

  const shortDebt = useShortDebt()
  const isShort = shortDebt.gt(0)

  const resetEthTradeAmount = useResetAtom(ethTradeAmountAtom)
  const resetSqfuTradeAmount = useResetAtom(sqfuTradeAmountAtom)
  const resetQuote = useResetAtom(quoteAtom)

  // let openError: string | undefined
  let closeError: string | undefined
  let existingShortError: string | undefined
  let priceImpactWarning: string | undefined

  if (connected) {
    if (squfuryAmount.lt(amount)) {
      closeError = 'Insufficient oSQFU balance'
    }
    // if (amount.gt(balance)) {
    //   openError = 'Insufficient ETH balance'
    // }
    if (isShort) {
      existingShortError = 'Close your short position to open a long'
    }
    if (new BigNumber(quote.priceImpact).gt(3)) {
      priceImpactWarning = 'High Price Impact'
    }
  }

  const longClosePriceImpactErrorState =
    priceImpactWarning && !closeError && !sellLoading && !squfuryAmount.isZero() && !isShort
  const error = existingShortError ? existingShortError : priceImpactWarning ? priceImpactWarning : ''

  const sellAndClose = useAppCallback(async () => {
    setSellLoading(true)
    try {
      if (squfuryAllowance.lt(amount) && !hasJustApprovedSquFury) {
        setIsTxFirstStep(true)
        await squfuryApprove(() => {
          setHasJustApprovedSquFury(true)
          setSellLoading(false)
        })
      } else {
        await sell(amount, () => {
          setIsTxFirstStep(false)
          setTradeSuccess(true)
          setTradeCompleted(true)

          resetEthTradeAmount()
          resetSqfuTradeAmount()
        })
      }
    } catch (e) {
      console.log(e)
      setSellLoading(false)
    }
  }, [
    amount,
    hasJustApprovedSquFury,
    resetEthTradeAmount,
    resetSqfuTradeAmount,
    sell,
    setIsTxFirstStep,
    setTradeCompleted,
    setTradeSuccess,
    squfuryAllowance,
    squfuryApprove,
  ])

  useAppEffect(() => {
    if (transactionInProgress) {
      setSellLoading(false)
    }
  }, [transactionInProgress])

  const sellQuoteHandler = useAppCallback(
    (sqfuAmount, slippage) => {
      if (parseFloat(sqfuAmount) === 0) {
        resetQuote()
        resetEthTradeAmount()
        return
      }

      setInputQuoteLoading(true)

      return getSellQuote(new BigNumber(sqfuAmount), slippage).then((quoteVal) => {
        if (quoteVal) {
          setQuote(quoteVal)

          setEthTradeAmount(quoteVal.amountOut.toString())
          setConfirmedAmount(Number(sqfuAmount).toFixed(6))
          setInputQuoteLoading(false)
        }
      })
    },
    [
      getSellQuote,
      resetEthTradeAmount,
      resetQuote,
      setQuote,
      setEthTradeAmount,
      setConfirmedAmount,
      setInputQuoteLoading,
    ],
  )

  const debouncedSellQuoteHandler = useAppMemo(() => debounce(sellQuoteHandler, 500), [sellQuoteHandler])

  useAppEffect(() => {
    debouncedSellQuoteHandler(sqfuTradeAmount, slippageAmount)
  }, [slippageAmount, sqfuTradeAmount, debouncedSellQuoteHandler])

  const handleSqfuChange = useAppCallback((value: string) => setSqfuTradeAmount(value), [setSqfuTradeAmount])

  const sellQuoteForETHHandler = useAppCallback(
    (ethAmount, slippage) => {
      setInputQuoteLoading(true)

      return getSellQuoteForETH(new BigNumber(ethAmount), slippage).then((quoteVal) => {
        setSqfuTradeAmount(quoteVal.amountIn.toString())
        setInputQuoteLoading(false)
      })
    },
    [setInputQuoteLoading, getSellQuoteForETH, setSqfuTradeAmount],
  )

  const debouncedSellQuoteForETHHandler = useAppMemo(
    () => debounce(sellQuoteForETHHandler, 500),
    [sellQuoteForETHHandler],
  )

  const handleEthChange = useAppCallback(
    (value: string) => {
      setEthTradeAmount(value)
      debouncedSellQuoteForETHHandler(value, slippageAmount)
    },
    [setEthTradeAmount, slippageAmount, debouncedSellQuoteForETHHandler],
  )

  const slippageAmountValue = isNaN(slippageAmount.toNumber()) ? 0 : slippageAmount.toNumber()
  const priceImpact = isNaN(Number(quote.priceImpact)) ? 0 : Number(quote.priceImpact)
  const priceImpactColor = priceImpact > 3 ? 'error' : undefined

  return (
    <div id="close-long-card">
      {confirmed && !isTxFirstStep ? (
        <>
          <Confirmed
            confirmationMessage={`Sold ${confirmedAmount} SquFury`}
            txnHash={transactionData?.hash ?? ''}
            confirmType={ConfirmType.TRADE}
          />
          <div className={classes.buttonDiv}>
            <PrimaryButtonNew
              fullWidth
              id="close-long-close-btn"
              variant="contained"
              onClick={() => {
                resetTransactionData()
              }}
            >
              {'Close'}
            </PrimaryButtonNew>
          </div>
        </>
      ) : cancelled ? (
        <>
          <Cancelled txnHash={transactionData?.hash ?? ''} />
          <div className={classes.buttonDiv}>
            <PrimaryButtonNew
              fullWidth
              variant="contained"
              onClick={() => {
                resetTransactionData()
                resetTxCancelled()
              }}
            >
              {'Close'}
            </PrimaryButtonNew>
          </div>
        </>
      ) : (
        <>
          <Typography variant="h4" className={classes.title}>
            Sell oSQFU to get ETH back
          </Typography>

          <Box display="flex" flexDirection="column" gridGap="16px">
            <InputToken
              id="close-long-osqfu-input"
              value={sqfuTradeAmount}
              onInputChange={handleSqfuChange}
              balance={squfuryAmount}
              logo={osqfuLogo}
              symbol="oSQFU"
              usdPrice={osqfuPrice}
              onBalanceClick={() => handleSqfuChange(squfuryAmount.toString())}
              error={!!closeError}
              helperText={closeError}
            />

            <InputToken
              id="close-long-eth-input"
              value={ethTradeAmount}
              onInputChange={handleEthChange}
              balance={new BigNumber(balance)}
              logo={ethLogo}
              symbol="ETH"
              usdPrice={ethPrice}
              showMaxAction={false}
            />
          </Box>

          <Collapse in={!!error}>
            <Alert severity="error" marginTop="24px">
              {error}
            </Alert>
          </Collapse>

          <Box
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            gridGap="12px"
            marginTop="24px"
            flexWrap="wrap"
          >
            <Metric
              label="Slippage"
              value={formatNumber(slippageAmountValue) + '%'}
              isSmall
              flexDirection="row"
              justifyContent="space-between"
              gridGap="12px"
            />
            <Box display="flex" alignItems="center" gridGap="12px" flex="1">
              <Metric
                label="Price Impact"
                value={formatNumber(priceImpact) + '%'}
                textColor={priceImpactColor}
                isSmall
                flexDirection="row"
                justifyContent="space-between"
                gridGap="12px"
              />

              <TradeSettings setSlippage={(amt) => setSlippage(amt)} slippage={slippageAmount} />
            </Box>
          </Box>

          {isRestricted && <RestrictionInfo withdrawAllowed={isWithdrawAllowed} marginTop="24px" />}

          <Box marginTop="24px" className={classes.buttonDiv}>
            {isRestricted && !isWithdrawAllowed ? (
              <PrimaryButtonNew
                fullWidth
                variant="contained"
                onClick={selectWallet}
                disabled={true}
                id="open-long-restricted-btn"
              >
                {'Unavailable'}
              </PrimaryButtonNew>
            ) : !connected ? (
              <PrimaryButtonNew
                fullWidth
                variant="contained"
                onClick={selectWallet}
                disabled={!!sellLoading}
                id="close-long-connect-wallet-btn"
              >
                {'Connect Wallet'}
              </PrimaryButtonNew>
            ) : (
              <PrimaryButtonNew
                fullWidth
                variant={longClosePriceImpactErrorState ? 'outlined' : 'contained'}
                onClick={sellAndClose}
                disabled={
                  !supportedNetwork ||
                  !!sellLoading ||
                  transactionInProgress ||
                  !!closeError ||
                  !!existingShortError ||
                  squfuryAmount.isZero() ||
                  sqfuTradeAmount === '0' ||
                  inputQuoteLoading
                }
                style={
                  longClosePriceImpactErrorState
                    ? { color: '#f5475c', backgroundColor: 'transparent', borderColor: '#f5475c' }
                    : {}
                }
                id="close-long-submit-tx-btn"
              >
                {!supportedNetwork ? (
                  'Unsupported Network'
                ) : sellLoading || transactionInProgress || inputQuoteLoading ? (
                  <CircularProgress color="primary" size="1.5rem" />
                ) : squfuryAllowance.lt(amount) && !hasJustApprovedSquFury ? (
                  'Approve oSQFU (1/2)'
                ) : longClosePriceImpactErrorState ? (
                  'Sell Anyway'
                ) : hasJustApprovedSquFury ? (
                  'Sell to close (2/2)'
                ) : (
                  'Sell to close'
                )}
              </PrimaryButtonNew>
            )}
          </Box>
        </>
      )}
    </div>
  )
}

type BuyProps = {
  open?: boolean
  isLPage?: boolean
  activeStep?: number
  showTitle?: boolean
}

const Long: React.FC<BuyProps> = ({ open, isLPage = false, activeStep = 0, showTitle = true }) => {
  return open ? (
    <OpenLong open={open} isLPage={isLPage} activeStep={activeStep} showTitle={showTitle} />
  ) : (
    <CloseLong isLPage={isLPage} activeStep={activeStep} showTitle={showTitle} />
  )
}

export default Long
