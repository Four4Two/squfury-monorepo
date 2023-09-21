import { ethers } from "hardhat"
import { expect } from "chai";
import { Contract, BigNumber, providers } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import BigNumberJs from 'bignumber.js'
import { WETH9, MockErc20, Controller, Oracle, WPowerPerp, CrabStrategy } from "../../../typechain";
import { deployUniswapV3, deploySquFuryCoreContracts, deployWETHAndDai, addWethDaiLiquidity, addSquFuryLiquidity, buyWSquFury, buyWeth } from '../../setup'
import { isSimilar, wmul, wdiv, one, oracleScaleFactor } from "../../utils"

BigNumberJs.set({EXPONENTIAL_AT: 30})

const calcPriceMulAndAuctionPrice = (isNegativeTargetHedge: boolean, maxPriceMultiplier: BigNumber, minPriceMultiplier: BigNumber, auctionExecution: BigNumber, currentWSquFuryPrice: BigNumber) : [BigNumber, BigNumber] => {
  let priceMultiplier: BigNumber
  let auctionWSquFuryEthPrice: BigNumber

  if(isNegativeTargetHedge) {
    priceMultiplier = maxPriceMultiplier.sub(wmul(auctionExecution, maxPriceMultiplier.sub(minPriceMultiplier)))
    auctionWSquFuryEthPrice = wmul(currentWSquFuryPrice, priceMultiplier);
  } 
  else {
    priceMultiplier = minPriceMultiplier.add(wmul(auctionExecution, maxPriceMultiplier.sub(minPriceMultiplier)))
    auctionWSquFuryEthPrice = wmul(currentWSquFuryPrice, priceMultiplier);
  }

  return [priceMultiplier, auctionWSquFuryEthPrice]
}

describe("Crab flashswap integration test: uniswap price based hedging", function () {
  const startingEthPrice = 3000
  const startingEthPrice1e18 = BigNumber.from(startingEthPrice).mul(one) // 3000 * 1e18
  const scaledStartingSquFuryPrice1e18 = startingEthPrice1e18.mul(11).div(10).div(oracleScaleFactor) // 0.303 * 1e18
  const scaledStartingSquFuryPrice = startingEthPrice*1.1 / oracleScaleFactor.toNumber() // 0.303


  const hedgeTimeThreshold = 86400  // 24h
  const hedgePriceThreshold = ethers.utils.parseUnits('0.01')
  const auctionTime = 3600
  const minPriceMultiplier = ethers.utils.parseUnits('0.95')
  const maxPriceMultiplier = ethers.utils.parseUnits('1.05')

  let provider: providers.JsonRpcProvider;
  let owner: SignerWithAddress;
  let depositor: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let dai: MockErc20
  let weth: WETH9
  let positionManager: Contract
  let uniswapFactory: Contract
  let swapRouter: Contract
  let oracle: Oracle
  let controller: Controller
  let wSquFuryPool: Contract
  let wSquFury: WPowerPerp
  let crabStrategy: CrabStrategy
  let ethDaiPool: Contract

  this.beforeAll("Deploy uniswap protocol & setup uniswap pool", async() => {
    const accounts = await ethers.getSigners();
    const [_owner, _depositor, _feeRecipient ] = accounts;
    owner = _owner;
    depositor = _depositor;
    feeRecipient = _feeRecipient;
    provider = ethers.provider

    const { dai: daiToken, weth: wethToken } = await deployWETHAndDai()

    dai = daiToken
    weth = wethToken

    const uniDeployments = await deployUniswapV3(weth)
    positionManager = uniDeployments.positionManager
    uniswapFactory = uniDeployments.uniswapFactory
    swapRouter = uniDeployments.swapRouter

    // this will not deploy a new pool, only reuse old onces
    const squfuryDeployments = await deploySquFuryCoreContracts(
      weth,
      dai, 
      positionManager, 
      uniswapFactory,
      scaledStartingSquFuryPrice,
      startingEthPrice
    )
    controller = squfuryDeployments.controller
    wSquFury = squfuryDeployments.wsqufury
    oracle = squfuryDeployments.oracle
    // shortSquFury = squfuryDeployments.shortSquFury
    wSquFuryPool = squfuryDeployments.wsqufuryEthPool
    ethDaiPool = squfuryDeployments.ethDaiPool

    await controller.connect(owner).setFeeRecipient(feeRecipient.address);
    await controller.connect(owner).setFeeRate(100)

    const CrabStrategyContract = await ethers.getContractFactory("CrabStrategy");
    crabStrategy = (await CrabStrategyContract.deploy(controller.address, oracle.address, weth.address, uniswapFactory.address, wSquFuryPool.address, hedgeTimeThreshold, hedgePriceThreshold, auctionTime, minPriceMultiplier, maxPriceMultiplier)) as CrabStrategy;
    
    const strategyCap = ethers.utils.parseUnits("1000")
    await crabStrategy.connect(owner).setStrategyCap(strategyCap)
    const strategyCapInContract = await crabStrategy.strategyCap()
    expect(strategyCapInContract.eq(strategyCap)).to.be.true
  })

  this.beforeAll("Seed pool liquidity", async() => {
    // add liquidity

    await addWethDaiLiquidity(
      startingEthPrice,
      ethers.utils.parseUnits('100'), // eth amount
      owner.address,
      dai,
      weth,
      positionManager
    )

    await provider.send("evm_increaseTime", [600])
    await provider.send("evm_mine", [])

    await addSquFuryLiquidity(
      scaledStartingSquFuryPrice, 
      '1000000',
      '2000000', 
      owner.address, 
      wSquFury, 
      weth, 
      positionManager, 
      controller
    )

    await provider.send("evm_increaseTime", [600])
    await provider.send("evm_mine", [])

  })

  this.beforeAll("Deposit into strategy", async () => {
    const ethToDeposit = ethers.utils.parseUnits('20')
    const msgvalue = ethers.utils.parseUnits('10.1')

    const depositorSquFuryBalanceBefore = await wSquFury.balanceOf(depositor.address)

    await crabStrategy.connect(depositor).flashDeposit(ethToDeposit, {value: msgvalue})
    
    const currentScaledSqfuryPrice = (await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 300, false))
    const feeRate = await controller.feeRate()
    const ethFeePerWSquFury = currentScaledSqfuryPrice.mul(feeRate).div(10000)
    const squfuryDelta = scaledStartingSquFuryPrice1e18.mul(2);
    const debtToMint = wdiv(ethToDeposit, (squfuryDelta.add(ethFeePerWSquFury)));
    const expectedEthDeposit = ethToDeposit.sub(debtToMint.mul(ethFeePerWSquFury).div(one))

    const totalSupply = (await crabStrategy.totalSupply())
    const depositorCrab = (await crabStrategy.balanceOf(depositor.address))
    const strategyVault = await controller.vaults(await crabStrategy.vaultId());
    const debtAmount = strategyVault.shortAmount
    const depositorSquFuryBalance = await wSquFury.balanceOf(depositor.address)
    const strategyContractSquFury = await wSquFury.balanceOf(crabStrategy.address)
    const lastHedgeTime = await crabStrategy.timeAtLastHedge()
    const currentBlockNumber = await provider.getBlockNumber()
    const currentBlock = await provider.getBlock(currentBlockNumber)
    const timeStamp = currentBlock.timestamp
    const collateralAmount = await strategyVault.collateralAmount

    expect(isSimilar(totalSupply.toString(),(expectedEthDeposit).toString())).to.be.true
    expect(isSimilar(depositorCrab.toString(),(expectedEthDeposit).toString())).to.be.true
    expect(isSimilar(debtAmount.toString(), debtToMint.toString())).to.be.true
    expect(depositorSquFuryBalance.eq(depositorSquFuryBalanceBefore)).to.be.true
    expect(strategyContractSquFury.eq(BigNumber.from(0))).to.be.true
    expect(lastHedgeTime.eq(timeStamp)).to.be.true
  })

  describe("Sell auction", async () => {
    before(async () => {
      // change pool price
      const ethToDeposit = ethers.utils.parseUnits('10000')
      const wSquFuryToMint = ethers.utils.parseUnits('10000')
      const currentBlockTimestamp = (await provider.getBlock(await provider.getBlockNumber())).timestamp
      await controller.connect(owner).mintWPowerPerpAmount("0", wSquFuryToMint, "0", {value: ethToDeposit})
      await buyWeth(swapRouter, wSquFury, weth, owner.address, (await wSquFury.balanceOf(owner.address)), currentBlockTimestamp + 10)
    })

    it("it should be eligible for a hedge after time has passed for twap to update but will revert due to hedge sign change", async () => {      
      // advance time for twap to update
      await provider.send("evm_increaseTime", [600])
      await provider.send("evm_mine", [])  
  
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp
      
      const priceAtLastHedge = await crabStrategy.priceAtLastHedge()
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const priceChange = one.mul(currentWSquFuryPrice).div(priceAtLastHedge)
      const priceDeviation = priceChange.gt(one) ? priceChange.sub(one): one.sub(priceChange)
      const canPriceHedge = await crabStrategy.checkPriceHedge(auctionTriggerTimer)
  
      expect(priceDeviation.gt(hedgePriceThreshold))
      expect(canPriceHedge).to.be.true
  
      // set next block timestamp     
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])
    
      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.true;
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.false;
  
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
  
      expect(isSellAuction).to.be.true
  
      await expect(
        crabStrategy.connect(depositor).priceHedgeOnUniswap(auctionTriggerTimer, ethers.utils.parseUnits('0.01'), BigNumber.from('0'))
      ).to.be.revertedWith("auction direction changed");
    })    
  
    it("should revert if not positive PnL", async () => {
      const auctionTriggerTimer = (await provider.getBlock(await provider.getBlockNumber())).timestamp

      // advanced more time to avoid traget hedge sign change
      await provider.send("evm_increaseTime", [auctionTime/3])
      await provider.send("evm_mine", [])        
      
      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 100;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])
    
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.false;
      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.true;
  
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(strategyDebt.mul(2), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
  
      expect(isSellAuction).to.be.true
  
      await expect(
        crabStrategy.connect(depositor).priceHedgeOnUniswap(auctionTriggerTimer, ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0'))
      ).to.be.revertedWith("ds-math-sub-underflow");
    })

    it("it should revert if PnL is less than min wsqufury", async () => {
      // advance time so hedge sign doesn't switch
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp - (auctionTime / 3)

      await provider.send("evm_increaseTime", [auctionTime/2])
      await provider.send("evm_mine", [])  
            
      const priceAtLastHedge = await crabStrategy.priceAtLastHedge()
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const priceChange = one.mul(currentWSquFuryPrice).div(priceAtLastHedge)
      const priceDeviation = priceChange.gt(one) ? priceChange.sub(one): one.sub(priceChange)
      const canPriceHedge = await crabStrategy.checkPriceHedge(auctionTriggerTimer)

      expect(priceDeviation.gt(hedgePriceThreshold))
      expect(canPriceHedge).to.be.true

      // set next block timestamp     
      const hedgeBlockNumber = await provider.getBlockNumber()
      const hedgeBlock = await provider.getBlock(hedgeBlockNumber)
      const hedgeBlockTimestamp = hedgeBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])
   
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()

      expect(isSellAuction).to.be.true

        
      await expect(
        crabStrategy.connect(depositor).priceHedgeOnUniswap(auctionTriggerTimer, ethers.utils.parseUnits('10'), ethers.utils.parseUnits('0'))
      ).to.be.revertedWith("profit is less than min wSquFury");
    })

    it("it should allow a hedge based on price", async () => {
      // advance time so hedge sign doesn't switch
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp - (auctionTime / 3)

      await provider.send("evm_increaseTime", [auctionTime/2])
      await provider.send("evm_mine", [])  
            
      const priceAtLastHedge = await crabStrategy.priceAtLastHedge()
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const priceChange = one.mul(currentWSquFuryPrice).div(priceAtLastHedge)
      const priceDeviation = priceChange.gt(one) ? priceChange.sub(one): one.sub(priceChange)
      const canPriceHedge = await crabStrategy.checkPriceHedge(auctionTriggerTimer)

      expect(priceDeviation.gt(hedgePriceThreshold))
      expect(canPriceHedge).to.be.true

      // set next block timestamp     
      const hedgeBlockNumber = await provider.getBlockNumber()
      const hedgeBlock = await provider.getBlock(hedgeBlockNumber)
      const hedgeBlockTimestamp = hedgeBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])
   
      const auctionTimeElapsed = BigNumber.from(hedgeBlockTimestamp).sub(auctionTriggerTimer)

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const currentScaledSqfuryPrice = (await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 300, false))
      const feeRate = await controller.feeRate()
      const ethFeePerWSquFury = currentScaledSqfuryPrice.mul(feeRate).div(10000)
  
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(strategyDebt.mul(2), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice.add(ethFeePerWSquFury))        
      const isSellAuction = targetHedge.isNegative()
      const auctionExecution = (auctionTimeElapsed.gte(BigNumber.from(auctionTime))) ? one : wdiv(auctionTimeElapsed, BigNumber.from(auctionTime))
      const result = calcPriceMulAndAuctionPrice(isSellAuction, maxPriceMultiplier, minPriceMultiplier, auctionExecution, currentWSquFuryPrice)
      const expectedAuctionWSquFuryEthPrice = result[1]
      const finalWSquFuryDelta = wmul(strategyDebt.mul(2), expectedAuctionWSquFuryEthPrice)
      const secondTargetHedge = wdiv(finalWSquFuryDelta.sub(ethDelta), expectedAuctionWSquFuryEthPrice.add(ethFeePerWSquFury))
      const expectedEthProceeds = wmul(secondTargetHedge.abs(), expectedAuctionWSquFuryEthPrice)
      const expectedEthDeposited = expectedEthProceeds.sub(wmul(ethFeePerWSquFury, secondTargetHedge.abs()))

      expect(isSellAuction).to.be.true

      await crabStrategy.connect(depositor).priceHedgeOnUniswap(auctionTriggerTimer, ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0'))
              
      const currentWSquFuryPriceAfter = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const strategyVaultAfter = await controller.vaults(await crabStrategy.vaultId());
      const strategyCollateralAmountAfter = strategyVaultAfter.collateralAmount
      const strategyDebtAmountAfter = strategyVaultAfter.shortAmount
      const timeAtLastHedgeAfter = await crabStrategy.timeAtLastHedge()
      const priceAtLastHedgeAfter = await crabStrategy.priceAtLastHedge()
      expect(isSimilar(strategyDebtAmountAfter.sub(strategyDebt).toString(), secondTargetHedge.abs().toString())).to.be.true
      expect(isSimilar(strategyCollateralAmountAfter.sub(ethDelta).toString(), expectedEthDeposited.toString())).to.be.true
      expect(timeAtLastHedgeAfter.eq(hedgeBlockTimestamp)).to.be.true
      expect(priceAtLastHedgeAfter.eq(currentWSquFuryPriceAfter)).to.be.true 
    })
    
    it("should revert price hedging if the price threshold has not been reached", async () => {        
      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
  
      await expect(
        crabStrategy.connect(depositor).priceHedgeOnUniswap(hedgeBlockTimestamp, ethers.utils.parseUnits('0.01'), BigNumber.from('0'))
      ).to.be.revertedWith("Price hedging not allowed");
    })
  })

  describe("Buy auction", async () => {
    before(async () => {
      const currentBlockTimestamp = (await provider.getBlock(await provider.getBlockNumber())).timestamp
      await buyWSquFury(swapRouter, wSquFury, weth, owner.address, ethers.utils.parseUnits('10000'), currentBlockTimestamp + 10)
    })

    it("should revert if not positive PnL", async () => {
      // advance time for twap to update
      await provider.send("evm_increaseTime", [600])
      await provider.send("evm_mine", []) 
            
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp
      
      const priceAtLastHedge = await crabStrategy.priceAtLastHedge()
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const priceChange = one.mul(currentWSquFuryPrice).div(priceAtLastHedge)
      const priceDeviation = priceChange.gt(one) ? priceChange.sub(one): one.sub(priceChange)
      const canPriceHedge = await crabStrategy.checkPriceHedge(auctionTriggerTimer)

      expect(priceDeviation.gt(hedgePriceThreshold))
      expect(canPriceHedge).to.be.true

      // set next block timestamp     
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])

      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.true;
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.false;

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()

      expect(isSellAuction).to.be.false

      await expect(
        crabStrategy.connect(depositor).priceHedgeOnUniswap(auctionTriggerTimer, 0, ethers.utils.parseUnits('0.0001'))
      ).to.be.revertedWith("ds-math-sub-underflow");
    })

    it("it should revert if profit is less than min ETH", async () => {
      const currentBlockTimestamp = (await provider.getBlock(await provider.getBlockNumber())).timestamp
      await buyWSquFury(swapRouter, wSquFury, weth, owner.address, ethers.utils.parseUnits('10000'), currentBlockTimestamp + 10)

      // advance time so hedge sign doesn't switch
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp

      await provider.send("evm_increaseTime", [auctionTime])
      await provider.send("evm_mine", [])  
            
      const priceAtLastHedge = await crabStrategy.priceAtLastHedge()
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const priceChange = one.mul(currentWSquFuryPrice).div(priceAtLastHedge)
      const priceDeviation = priceChange.gt(one) ? priceChange.sub(one): one.sub(priceChange)
      const canPriceHedge = await crabStrategy.checkPriceHedge(auctionTriggerTimer)

      expect(priceDeviation.gt(hedgePriceThreshold))
      expect(canPriceHedge).to.be.true

      const normFactor = await controller.getExpectedNormalizationFactor()

      const collatToDeposit = one.mul(normFactor).mul(2).mul(startingEthPrice).div(oracleScaleFactor).div(one)

      await controller.connect(depositor).mintWPowerPerpAmount("0", ethers.utils.parseUnits("3"), "0", {value: collatToDeposit.mul(10)})
      const senderWsqufuryBalanceBefore = await wSquFury.balanceOf(depositor.address)
      await wSquFury.connect(depositor).approve(crabStrategy.address, senderWsqufuryBalanceBefore)

      // set next block timestamp     
      const hedgeBlockNumber = await provider.getBlockNumber()
      const hedgeBlock = await provider.getBlock(hedgeBlockNumber)
      const hedgeBlockTimestamp = hedgeBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()

      expect(isSellAuction).to.be.false

      await expect(
        crabStrategy.connect(depositor).priceHedgeOnUniswap(auctionTriggerTimer, 0, ethers.utils.parseUnits('5'))
      ).to.be.revertedWith("profit is less than min ETH");
    })    
    
    it("it should allow a hedge based on price", async () => {
      // advance time so hedge sign doesn't switch
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp - auctionTime
            
      const priceAtLastHedge = await crabStrategy.priceAtLastHedge()
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const priceChange = one.mul(currentWSquFuryPrice).div(priceAtLastHedge)
      const priceDeviation = priceChange.gt(one) ? priceChange.sub(one): one.sub(priceChange)
      const canPriceHedge = await crabStrategy.checkPriceHedge(auctionTriggerTimer)

      expect(priceDeviation.gt(hedgePriceThreshold))
      expect(canPriceHedge).to.be.true

      const normFactor = await controller.getExpectedNormalizationFactor()


      const collatToDeposit = one.mul(normFactor).mul(2).mul(startingEthPrice).div(oracleScaleFactor).div(one)

      await controller.connect(depositor).mintWPowerPerpAmount("0", ethers.utils.parseUnits("3"), "0", {value: collatToDeposit.mul(10)})
      const senderWsqufuryBalanceBefore = await wSquFury.balanceOf(depositor.address)
      await wSquFury.connect(depositor).approve(crabStrategy.address, senderWsqufuryBalanceBefore)

      // set next block timestamp     
      const hedgeBlockNumber = await provider.getBlockNumber()
      const hedgeBlock = await provider.getBlock(hedgeBlockNumber)
      const hedgeBlockTimestamp = hedgeBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])

      const auctionTimeElapsed = BigNumber.from(hedgeBlockTimestamp).sub(auctionTriggerTimer)

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
      const auctionExecution = (auctionTimeElapsed.gte(BigNumber.from(auctionTime))) ? one : wdiv(auctionTimeElapsed, BigNumber.from(auctionTime))
      const result = calcPriceMulAndAuctionPrice(isSellAuction, maxPriceMultiplier, minPriceMultiplier, auctionExecution, currentWSquFuryPrice)
      const expectedAuctionWSquFuryEthPrice = result[1]
      const finalWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), expectedAuctionWSquFuryEthPrice)
      const secondTargetHedge = wdiv(finalWSquFuryDelta.sub(ethDelta), expectedAuctionWSquFuryEthPrice)
      const expectedEthProceeds = wmul(secondTargetHedge.abs(), expectedAuctionWSquFuryEthPrice)

      expect(isSellAuction).to.be.false

      await crabStrategy.connect(depositor).priceHedgeOnUniswap(auctionTriggerTimer, 0, ethers.utils.parseUnits('0.001'))
              
      const currentWSquFuryPriceAfter = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const strategyVaultAfter = await controller.vaults(await crabStrategy.vaultId());
      const strategyCollateralAmountAfter = strategyVaultAfter.collateralAmount
      const strategyDebtAmountAfter = strategyVaultAfter.shortAmount
      const timeAtLastHedgeAfter = await crabStrategy.timeAtLastHedge()
      const priceAtLastHedgeAfter = await crabStrategy.priceAtLastHedge()

      expect(isSimilar(strategyDebtAmountAfter.sub(strategyDebt).toString(), secondTargetHedge.mul(-1).toString())).to.be.true
      expect(isSimilar(strategyCollateralAmountAfter.sub(ethDelta).toString(), (expectedEthProceeds.mul(-1)).toString())).to.be.true
      expect(timeAtLastHedgeAfter.eq(hedgeBlockTimestamp)).to.be.true
      expect(priceAtLastHedgeAfter.eq(currentWSquFuryPriceAfter)).to.be.true 
    })    
  })
})