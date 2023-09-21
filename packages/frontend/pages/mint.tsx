import React from 'react'
import { Box, Typography } from '@material-ui/core'
import { createStyles, makeStyles } from '@material-ui/core/styles'

import MintSquFury from '@components/Trade/Mint'
import Nav from '@components/Nav'
import DefaultSiteSeo from '@components/DefaultSiteSeo/DefaultSiteSeo'

const useStyles = makeStyles((theme) =>
  createStyles({
    container: {
      padding: theme.spacing(4, 0),
    },
    title: {
      fontSize: '20px',
      fontWeight: 700,
      letterSpacing: '-0.01em',
    },
    getSquFuryCard: {
      width: '440px',
      margin: 'auto',
      padding: theme.spacing(2, 0),
    },
  }),
)

const MintPage: React.FC = () => {
  const classes = useStyles()

  return (
    <>
      <DefaultSiteSeo />
      <Nav />

      <div className={classes.container}>
        <Typography align="center" variant="h6" className={classes.title}>
          Mint SquFury
        </Typography>

        <Box className={classes.getSquFuryCard}>
          <MintSquFury onMint={() => console.log('Minted')} showManageLink />
        </Box>
      </div>
    </>
  )
}

export default MintPage
