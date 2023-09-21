import axios from 'axios'
import type { NextApiRequest, NextApiResponse } from 'next'

const SQUFURY_VOL_API = process.env.SQUFURY_VOL_API_BASE_URL

const handleRequest = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!SQUFURY_VOL_API) {
    res.status(400).json({ status: 'error', message: 'Error fetching information' })
    return
  }

  const jsonResponse = await axios.get(`${SQUFURY_VOL_API}/get_squfury_iv`)
  res.status(200).json(jsonResponse.data['squfuryVol'])
}

export default handleRequest
