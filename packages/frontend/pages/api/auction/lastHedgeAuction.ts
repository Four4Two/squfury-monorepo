import axios from 'axios'
import type { NextApiRequest, NextApiResponse } from 'next'

const SQUFURY_PORTAL_API = process.env.NEXT_PUBLIC_SQUFURY_PORTAL_BASE_URL

const handleRequest = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!SQUFURY_PORTAL_API) {
    res.status(400).json({ status: 'error', message: 'Error fetching information' })
    return
  }

  const jsonResponse = await axios.get(`${SQUFURY_PORTAL_API}/api/auction/getLastHedge?type=${req.query.type}`)
  res.status(200).json(jsonResponse.data)
}

export default handleRequest
