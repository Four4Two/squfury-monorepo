import { ethers } from "hardhat"
import { expect } from "chai";
import { Contract, BigNumber, providers } from "ethers";
import BigNumberJs from 'bignumber.js'

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
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

describe("Crab flashswap integration test: price based hedging", function () {
  const startingEthPrice = 3000
  const startingEthPrice1e18 = BigNumber.from(startingEthPrice).mul(one) // 3000 * 1e18
  const scaledStartingSquFuryPrice1e18 = startingEthPrice1e18.mul(11).div(10).div(oracleScaleFactor) // 0.303 * 1e18
  const scaledStartingSquFuryPrice = startingEthPrice*1.1 / oracleScaleFactor.toNumber() // 0.303


  const hedgeTimeThreshold = 86400  // 24h
  const hedgePriceThreshold = ethers.utils.parseUnits('0.01')
  const auctionTime = 3600
  const minPriceMultiplier = ethers.utils.parseUnits('0.95')
  const maxPriceMultiplier = ethers.utils.parseUnits('1.05')

  let initialTimestamp : number
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
    const [_owner, _depositor, _feeRecipient] = accounts;
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

    // Record time stamp at initialization
    const currentBlockNumber = await provider.getBlockNumber()
    const currentBlock = await provider.getBlock(currentBlockNumber)
    initialTimestamp = currentBlock.timestamp

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
    
    const normFactor = await controller.normalizationFactor()
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
      
      // ensure that we have a twap of 600s
      await provider.send("evm_increaseTime", [600])
      await provider.send("evm_mine", [])
    })

    it("should revert price hedging if the time threshold has not been reached", async () => {  
      const timeAtLastHedge = await crabStrategy.timeAtLastHedge()
      
      
      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])  
      expect((timeAtLastHedge.add(hedgeTimeThreshold)).gt(hedgeBlockTimestamp)).to.be.true
  
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(strategyDebt.mul(2), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)
      const isSellAuction = targetHedge.isNegative()
      await expect(
        crabStrategy.connect(depositor).priceHedge(hedgeBlockTimestamp, isSellAuction, 0, {value: 1})
      ).to.be.revertedWith("Price hedging not allowed");
    })
    
    it("price hedging should not immediately be eligible for a hedge", async () => {
      // change pool price
      const ethToDeposit = ethers.utils.parseUnits('10000')
      const wSquFuryToMint = ethers.utils.parseUnits('10000')
      const currentBlockTimestamp = (await provider.getBlock(await provider.getBlockNumber())).timestamp
      await controller.connect(owner).mintWPowerPerpAmount("0", wSquFuryToMint, "0", {value: ethToDeposit})
      await buyWeth(swapRouter, wSquFury, weth, owner.address, (await wSquFury.balanceOf(owner.address)), currentBlockTimestamp + 10)

      const priceAtLastHedge = await crabStrategy.priceAtLastHedge()
      
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const priceChange = one.mul(currentWSquFuryPrice).div(priceAtLastHedge)
      const priceDeviation = priceChange.gt(one) ? priceChange.sub(one): one.sub(priceChange)
      
      expect(priceDeviation.lt(hedgePriceThreshold))

      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])   
      
      const auctionTimeElapsed = BigNumber.from(hedgeBlockTimestamp).sub(auctionTriggerTimer)

      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.false;
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.false;

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const normFactor = await controller.normalizationFactor()
      const currentScaledEthPrice = (await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 300, false)).div(oracleScaleFactor)
      const feeRate = await controller.feeRate()
      const ethFeePerWSquFury = currentScaledEthPrice.mul(normFactor).mul(feeRate).div(10000).div(one)  

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

      await expect(
        crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, isSellAuction, expectedAuctionWSquFuryEthPrice, {value: expectedEthProceeds})
      ).to.be.revertedWith("Price hedging not allowed");
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

      const auctionTimeElapsed = BigNumber.from(hedgeBlockTimestamp).sub(auctionTriggerTimer)

      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.true;
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.false;

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const normFactor = await controller.normalizationFactor()
      const currentScaledEthPrice = (await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 300, false)).div(oracleScaleFactor)
      const feeRate = await controller.feeRate()
      const ethFeePerWSquFury = currentScaledEthPrice.mul(normFactor).mul(feeRate).div(10000).div(one)  

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

      await expect(
        crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, isSellAuction, expectedAuctionWSquFuryEthPrice, {value: expectedEthProceeds.add(1)})
      ).to.be.revertedWith("auction direction changed");
    })    

    it("it should revert if hedger specifies the wrong direction", async () => {
      // advance time so hedge sign doesn't switch
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp

      await provider.send("evm_increaseTime", [auctionTime/2])
      await provider.send("evm_mine", [])  
      
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)

      // set next block timestamp     
      const hedgeBlockNumber = await provider.getBlockNumber()
      const hedgeBlock = await provider.getBlock(hedgeBlockNumber)
      const hedgeBlockTimestamp = hedgeBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])

      const auctionTimeElapsed = BigNumber.from(hedgeBlockTimestamp).sub(auctionTriggerTimer)

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const normFactor = await controller.normalizationFactor()
      const currentScaledEthPrice = (await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 300, false)).div(oracleScaleFactor)
      const feeRate = await controller.feeRate()
      const ethFeePerWSquFury = currentScaledEthPrice.mul(normFactor).mul(feeRate).div(10000).div(one)  

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

      await expect(
        crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, !isSellAuction, expectedAuctionWSquFuryEthPrice, {value: expectedEthProceeds.add(1)})
      ).to.be.revertedWith("wrong auction type");
    })
    
    it("it should allow a hedge based on price", async () => {
      // advance time so hedge sign doesn't switch
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp

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
      const normFactor = await controller.normalizationFactor()
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

      const senderWsqufuryBalanceBefore = await wSquFury.balanceOf(depositor.address)

      // this fails when running yarn test but not as an individial test as expectedEthProceeds and secondTargetHedge is off by 1wei in yarn test but not in single test run
      // any ideas?
      await crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, isSellAuction, expectedAuctionWSquFuryEthPrice, {value: expectedEthProceeds.add(1)})
              
      const currentWSquFuryPriceAfter = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const strategyVaultAfter = await controller.vaults(await crabStrategy.vaultId());
      const strategyCollateralAmountAfter = strategyVaultAfter.collateralAmount
      const strategyDebtAmountAfter = strategyVaultAfter.shortAmount
      const senderWsqufuryBalanceAfter = await wSquFury.balanceOf(depositor.address)
      const timeAtLastHedgeAfter = await crabStrategy.timeAtLastHedge()
      const priceAtLastHedgeAfter = await crabStrategy.priceAtLastHedge()

      expect(isSimilar(senderWsqufuryBalanceAfter.sub(senderWsqufuryBalanceBefore).toString(), secondTargetHedge.mul(-1).toString())).to.be.true
      expect(isSimilar(strategyDebtAmountAfter.sub(strategyDebt).toString(), secondTargetHedge.mul(-1).toString())).to.be.true
      expect(isSimilar(strategyCollateralAmountAfter.sub(ethDelta).toString(), expectedEthDeposited.toString())).to.be.true
      expect(timeAtLastHedgeAfter.eq(hedgeBlockTimestamp)).to.be.true
      expect(priceAtLastHedgeAfter.eq(currentWSquFuryPriceAfter)).to.be.true 
    })    
  })

  describe("Buy auction", async () => {
    before(async () => {
      const currentBlockTimestamp = (await provider.getBlock(await provider.getBlockNumber())).timestamp
      await buyWSquFury(swapRouter, wSquFury, weth, owner.address, ethers.utils.parseUnits('7500'), currentBlockTimestamp + 10)
    })

    it("should not immediately be eligible for a hedge", async () => {
      const priceAtLastHedge = await crabStrategy.priceAtLastHedge()
      
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const priceChange = one.mul(currentWSquFuryPrice).div(priceAtLastHedge)
      const priceDeviation = priceChange.gt(one) ? priceChange.sub(one): one.sub(priceChange)
      
      expect(priceDeviation.lt(hedgePriceThreshold))

      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])  
      
      const auctionTimeElapsed = BigNumber.from(hedgeBlockTimestamp).sub(auctionTriggerTimer)

      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.false;
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.false;

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
      const auctionExecution = (auctionTimeElapsed.gte(BigNumber.from(auctionTime))) ? one : wdiv(auctionTimeElapsed, BigNumber.from(auctionTime))
      const result = calcPriceMulAndAuctionPrice(isSellAuction, maxPriceMultiplier, minPriceMultiplier, auctionExecution, currentWSquFuryPrice)
      const expectedAuctionWSquFuryEthPrice = result[1]

      const senderWsqufuryBalanceBefore = await wSquFury.balanceOf(depositor.address)
      await wSquFury.connect(depositor).approve(crabStrategy.address, senderWsqufuryBalanceBefore)

      await expect(
        crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, isSellAuction, expectedAuctionWSquFuryEthPrice)
      ).to.be.revertedWith("Price hedging not allowed");
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

      const auctionTimeElapsed = BigNumber.from(hedgeBlockTimestamp).sub(auctionTriggerTimer)

      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.true;
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.false;

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
      const auctionExecution = (auctionTimeElapsed.gte(BigNumber.from(auctionTime))) ? one : wdiv(auctionTimeElapsed, BigNumber.from(auctionTime))
      const result = calcPriceMulAndAuctionPrice(isSellAuction, maxPriceMultiplier, minPriceMultiplier, auctionExecution, currentWSquFuryPrice)
      const expectedAuctionWSquFuryEthPrice = result[1]

      expect(isSellAuction).to.be.false

      await expect(
        crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, isSellAuction, expectedAuctionWSquFuryEthPrice)
      ).to.be.revertedWith("auction direction changed");
    })    

    it("it should revert if hedger specifies the wrong direction", async () => {
      // advance time so hedge sign doesn't switch
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp

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
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
      const auctionExecution = (auctionTimeElapsed.gte(BigNumber.from(auctionTime))) ? one : wdiv(auctionTimeElapsed, BigNumber.from(auctionTime))
      const result = calcPriceMulAndAuctionPrice(isSellAuction, maxPriceMultiplier, minPriceMultiplier, auctionExecution, currentWSquFuryPrice)
      const expectedAuctionWSquFuryEthPrice = result[1]

      expect(isSellAuction).to.be.false

      await expect(
        crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, !isSellAuction,expectedAuctionWSquFuryEthPrice)
      ).to.be.revertedWith("wrong auction type");
    })
    
    it("it should revert if eth is attached to a buy auction", async () => {      
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp
      
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

      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.true;
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.false;

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
      const auctionExecution = (auctionTimeElapsed.gte(BigNumber.from(auctionTime))) ? one : wdiv(auctionTimeElapsed, BigNumber.from(auctionTime))
      const result = calcPriceMulAndAuctionPrice(isSellAuction, maxPriceMultiplier, minPriceMultiplier, auctionExecution, currentWSquFuryPrice)
      const expectedAuctionWSquFuryEthPrice = result[1]

      expect(isSellAuction).to.be.false

      await expect(
        crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, isSellAuction, expectedAuctionWSquFuryEthPrice, {value: 1})
      ).to.be.revertedWith("ETH attached for buy auction");
    })   

    it("it should revert if the limit price is breached", async () => {      
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp
      
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

      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.true;
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.false;

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
      const auctionExecution = (auctionTimeElapsed.gte(BigNumber.from(auctionTime))) ? one : wdiv(auctionTimeElapsed, BigNumber.from(auctionTime))
      const result = calcPriceMulAndAuctionPrice(isSellAuction, maxPriceMultiplier, minPriceMultiplier, auctionExecution, currentWSquFuryPrice)
      const expectedAuctionWSquFuryEthPrice = result[1]
      
      expect(isSellAuction).to.be.false

      await expect(
        crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, isSellAuction, expectedAuctionWSquFuryEthPrice.mul(2))
      ).to.be.revertedWith("Auction price < min price");
    })  

    it("it should allow a hedge based on price", async () => {
      // advance time so hedge sign doesn't switch
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const auctionTriggerTimer = currentBlock.timestamp

      await provider.send("evm_increaseTime", [auctionTime/2])
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

      await crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, isSellAuction, expectedAuctionWSquFuryEthPrice)
              
      const currentWSquFuryPriceAfter = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const senderWsqufuryBalanceAfter = await wSquFury.balanceOf(depositor.address)
      const strategyVaultAfter = await controller.vaults(await crabStrategy.vaultId());
      const strategyCollateralAmountAfter = strategyVaultAfter.collateralAmount
      const strategyDebtAmountAfter = strategyVaultAfter.shortAmount
      const timeAtLastHedgeAfter = await crabStrategy.timeAtLastHedge()
      const priceAtLastHedgeAfter = await crabStrategy.priceAtLastHedge()

      expect(isSimilar(senderWsqufuryBalanceAfter.sub(senderWsqufuryBalanceBefore).toString(), secondTargetHedge.mul(-1).toString())).to.be.true
      expect(isSimilar(strategyDebtAmountAfter.sub(strategyDebt).toString(), secondTargetHedge.mul(-1).toString())).to.be.true
      expect(isSimilar(strategyCollateralAmountAfter.sub(ethDelta).toString(), (expectedEthProceeds.mul(-1)).toString())).to.be.true
      expect(timeAtLastHedgeAfter.eq(hedgeBlockTimestamp)).to.be.true
      expect(priceAtLastHedgeAfter.eq(currentWSquFuryPriceAfter)).to.be.true 
    })

    it("it should not allow a hedge based on a time before previous hedge", async () => {

      // Set trigger time just after initialization 
      const auctionTriggerTimer = initialTimestamp + 600
      // Set up hedge            
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
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

      // try to hedge at timestamp before last hedge
      await expect( 
         crabStrategy.connect(depositor).priceHedge(auctionTriggerTimer, isSellAuction, expectedAuctionWSquFuryEthPrice)
      ).to.be.revertedWith("Price hedging not allowed") 
      })
  })
})