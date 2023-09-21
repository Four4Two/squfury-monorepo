import { createStyles, makeStyles } from '@material-ui/core/styles'
import React from 'react'

import { Steps, useLPState } from '@context/lp'
import GetSquFury from './GetSquFury'
import ProvideLiquidity from './ProvideLiquidity'
import SelectMethod from './SelectMethod'
import Stepper from './Stepper'

const useStyles = makeStyles(() =>
  createStyles({
    container: {
      display: 'flex',
      justifyContent: 'center',
      flexDirection: 'column',
    },
  }),
)

const ObtainSquFury: React.FC = () => {
  const classes = useStyles()
  const { lpState } = useLPState()

  return (
    <div className={classes.container}>
      {lpState.step === Steps.SELECT_METHOD ? <SelectMethod /> : null}
      {lpState.step === Steps.GET_SQUFURY ? <GetSquFury /> : null}
      {lpState.step === Steps.PROVIDE_LIQUIDITY ? <ProvideLiquidity /> : null}
      <Stepper />
    </div>
  )
}

export default ObtainSquFury
