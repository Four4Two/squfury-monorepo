import LabelWithTooltip from '@components/LabelWithTooltip'
import SquFuryCard from '@components/SquFuryCard'
import useYourVaults from '../../hooks/useYourVaults'
import { Grid, Typography } from '@material-ui/core'
import { toTokenAmount } from '../../utils/calculations'
import BigNumber from 'bignumber.js'
import Link from 'next/link'
import { FC } from 'react'

const YourVaults: FC = () => {
  const { data: { vaults } = {}, loading, error } = useYourVaults()

  if (error) {
    return <Typography color="error">{error.message}</Typography>
  }

  if (loading) {
    return <Typography>Loading...</Typography>
  }

  return (
    <>
      {vaults?.map((vault, index) => (
        <Link key={vault.id} href={`/vault/${vault.id}`} passHref>
          <a>
            <SquFuryCard mt={index ? 2 : 0}>
              <Grid container>
                <Grid item md={4}>
                  <LabelWithTooltip labelVariant="caption" label="Id" />
                  <Typography variant="body1">{vault.id}</Typography>
                </Grid>

                <Grid item md={4}>
                  <LabelWithTooltip labelVariant="caption" label="Short Amount" />
                  <Typography variant="body1">
                    {toTokenAmount(new BigNumber(vault.shortAmount), 18).toFixed(4)}&nbsp; oSQFU
                  </Typography>
                </Grid>

                <Grid item md={4}>
                  <LabelWithTooltip labelVariant="caption" label="Collateral Amount" />
                  <Typography variant="body1">
                    {toTokenAmount(new BigNumber(vault.collateralAmount), 18).toFixed(4)}&nbsp; ETH
                  </Typography>
                </Grid>
              </Grid>
            </SquFuryCard>
          </a>
        </Link>
      ))}
    </>
  )
}

export default YourVaults
