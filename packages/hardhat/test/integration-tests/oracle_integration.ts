import { ethers, getNamedAccounts } from "hardhat"
import { expect } from "chai";
import { Contract } from "ethers";
import { Controller, Oracle, WETH9, WPowerPerp } from "../../typechain";
import { isSimilar } from '../utils'
import { deployUniswapV3, deploySquFuryCoreContracts, addSquFuryLiquidity, deployWETHAndDai } from '../setup'

describe("Oracle Integration Test", function () {
  let oracle: Oracle;
  let dai: Contract
  let weth: WETH9
  let squfury: WPowerPerp
  let squfuryPool: Contract
  let ethDaiPool: Contract
  let positionManager: Contract
  let controller: Controller
  const startingPrice = 3000
  const provider = ethers.provider

  this.beforeAll("Deploy uniswap protocol & setup uniswap pool", async() => {
  
    const { dai: daiToken, weth: wethToken } = await deployWETHAndDai()

    dai = daiToken
    weth = wethToken

    const uniDeployments = await deployUniswapV3(weth)

    // this will not deploy a new pool, only reuse old onces
    const coreDeployments = await deploySquFuryCoreContracts(
      weth,
      dai, 
      uniDeployments.positionManager, 
      uniDeployments.uniswapFactory,
      startingPrice,
      startingPrice
    )

    positionManager = uniDeployments.positionManager

    squfury = coreDeployments.wsqufury
    controller = coreDeployments.controller
    squfuryPool = coreDeployments.wsqufuryEthPool
    ethDaiPool = coreDeployments.ethDaiPool
    oracle = coreDeployments.oracle
  })

  describe('Get TWAP right after setup', async( )=> {
    describe("TWAP for squfury/eth", async () => {
      this.beforeEach(async () => {
        await provider.send("evm_increaseTime", [10])
        await provider.send("evm_mine", [])
      })
  
      it("fetch initial price", async () => {
        const price = await oracle.getTwap(squfuryPool.address, squfury.address, weth.address, 1, false)
        expect(isSimilar(price.toString(), (startingPrice * 1e18).toString())).to.be.true
      })
      it("fetch price twap for last 10 seconds", async () => {
        const price = await oracle.getTwap(squfuryPool.address, squfury.address, weth.address, 10, false)
        expect(isSimilar(price.toString(), (startingPrice * 1e18).toString())).to.be.true
      })
      it("should revert while requesting twap with price too old", async () => {
        await expect(
          oracle.getTwap(squfuryPool.address, squfury.address, weth.address, 600, false)
        ).to.be.revertedWith("OLD");
      })  
    })
  
    describe("TWAP for eth/dai", async () => {  
      it("fetch initial price", async () => {
        const price = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 1, false)
        expect(isSimilar(price.toString(), (startingPrice * 1e18).toString())).to.be.true
      })
      it("fetch price twap for last 10 seconds", async () => {
        const price = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 10, false)
        expect(isSimilar(price.toString(), (startingPrice * 1e18).toString())).to.be.true
      })  
      it("should revert while requesting twap with price too old", async () => {
        await expect(
          oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 600, false)
        ).to.be.revertedWith("OLD");
      })  
    })
  })

  describe('Get TWAP right after 10 mins', async( )=> {
    it('go 10 mins', async() => {
      await provider.send("evm_increaseTime", [600]) // go 10 minutes
    })
    it("fetch squfury twap for last 10 mins", async () => {
      const price = await oracle.getTwap(squfuryPool.address, squfury.address, weth.address, 600, false)
      expect(isSimilar(price.toString(), (startingPrice * 1e18).toString())).to.be.true
    })  
    it("fetch eth twap for last 10 mins", async () => {
      const price = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 600, false)
      expect(isSimilar(price.toString(), (startingPrice * 1e18).toString())).to.be.true
    })  
  })

  describe('Adding liquidity mess up things', async() => {
    it('add liquidity', async() => {
      const { deployer } = await getNamedAccounts();
      await addSquFuryLiquidity(3000, '0.001', '10', deployer, squfury, weth, positionManager, controller)
    })
    it("fetch squfury twap for last 10 mins", async () => {
      const price = await oracle.getTwap(squfuryPool.address, squfury.address, weth.address, 600, false)
      expect(isSimilar(price.toString(), (startingPrice * 1e18).toString())).to.be.true
    })
  })
})
