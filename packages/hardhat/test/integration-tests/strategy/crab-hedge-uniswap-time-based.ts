import { ethers } from "hardhat"
import { expect } from "chai";
import BigNumberJs from 'bignumber.js'
import { Contract, BigNumber, providers } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { WETH9, MockErc20, Controller, Oracle, WPowerPerp, CrabStrategy } from "../../../typechain";
import { deployUniswapV3, deploySquFuryCoreContracts, deployWETHAndDai, addWethDaiLiquidity, addSquFuryLiquidity, buyWeth } from '../../setup'
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

describe("Crab flashswap integration test: uniswap time based hedging", function () {
  const startingEthPrice = 3000
  const startingEthPrice1e18 = BigNumber.from(startingEthPrice).mul(one) // 3000 * 1e18
  const scaledStartingSquFuryPrice1e18 = startingEthPrice1e18.mul(12).div(10).div(oracleScaleFactor) // 0.303 * 1e18
  const scaledStartingSquFuryPrice = startingEthPrice*1.2 / oracleScaleFactor.toNumber() // 0.303

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
    it("should revert time hedging if the time threshold has not been reached", async () => {  
      const timeAtLastHedge = await crabStrategy.timeAtLastHedge()
      
      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])  
      expect((timeAtLastHedge.add(hedgeTimeThreshold)).gt(hedgeBlockTimestamp)).to.be.true
  
      await expect(
        crabStrategy.connect(depositor).timeHedgeOnUniswap(ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0.0001'))
      ).to.be.revertedWith("Time hedging is not allowed");
    })  

    it("should revert hedging if strategy is delta neutral", async () => {  
          
      await provider.send("evm_increaseTime", [hedgeTimeThreshold])
      await provider.send("evm_mine", [])

      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])  
        
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(strategyDebt.mul(2), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)

      expect(targetHedge.abs().eq(BigNumber.from(0)) || isSimilar(initialWSquFuryDelta.toString(), ethDelta.toString())).to.be.true
      await expect(
        crabStrategy.connect(depositor).timeHedgeOnUniswap(ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0.0001'))
      ).to.be.revertedWith("strategy is delta neutral");
    })

    it("should revert hedging if target hedge sign change (auction change from selling to buying)", async () => {
      // change pool price for auction to be sell auction
      const ethToDeposit = ethers.utils.parseUnits('1000')
      const wSquFuryToMint = ethers.utils.parseUnits('1000')
      const currentBlockTimestamp = (await provider.getBlock(await provider.getBlockNumber())).timestamp
      await controller.connect(owner).mintWPowerPerpAmount("0", wSquFuryToMint, "0", {value: ethToDeposit})
      await buyWeth(swapRouter, wSquFury, weth, owner.address, (await wSquFury.balanceOf(owner.address)), currentBlockTimestamp + 10)

      await provider.send("evm_increaseTime", [600])
      await provider.send("evm_mine", [])              

      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])      

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)        
      const isSellAuction = targetHedge.isNegative()

      expect(isSellAuction).to.be.true

      await expect(
        crabStrategy.connect(depositor).timeHedgeOnUniswap(ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0.0001'))
      ).to.be.revertedWith("auction direction changed");
    })

    it("should revert if not positive PnL", async () => {
      const timeAtLastHedge = await crabStrategy.timeAtLastHedge()
      const hedgeTimeTolerance = await crabStrategy.hedgeTimeThreshold()      
      const auctionTriggerTimer = timeAtLastHedge.add(hedgeTimeTolerance)
      
      // advanced more time to avoid traget hedge sign change
      await provider.send("evm_increaseTime", [auctionTime/3])
      await provider.send("evm_mine", [])        
      
      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])

      const auctionTimeElapsed = BigNumber.from(hedgeBlockTimestamp).sub(auctionTriggerTimer)
  
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.true;
      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.false;
  
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(strategyDebt.mul(2), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
      const auctionExecution = (auctionTimeElapsed.gte(BigNumber.from(auctionTime))) ? one : wdiv(auctionTimeElapsed, BigNumber.from(auctionTime))
      const result = calcPriceMulAndAuctionPrice(isSellAuction, maxPriceMultiplier, minPriceMultiplier, auctionExecution, currentWSquFuryPrice)
      const expectedAuctionWSquFuryEthPrice = result[1]

      expect(isSellAuction).to.be.true
      expect(expectedAuctionWSquFuryEthPrice.lt(currentWSquFuryPrice)).to.be.true

      await expect(
        crabStrategy.connect(depositor).timeHedgeOnUniswap(ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0.0001'))
      ).to.be.revertedWith("ds-math-sub-underflow");
    })

    it("hedge on uniswap based on time threshold", async () => {
      const timeAtLastHedge = await crabStrategy.timeAtLastHedge()
      const hedgeTimeTolerance = await crabStrategy.hedgeTimeThreshold()      
      const auctionTriggerTimer = timeAtLastHedge.add(hedgeTimeTolerance)
      
      // advanced more time to avoid traget hedge sign change
      await provider.send("evm_increaseTime", [auctionTime])
      await provider.send("evm_mine", [])        
      
      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 100;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])

      const auctionTimeElapsed = BigNumber.from(hedgeBlockTimestamp).sub(auctionTriggerTimer)
  
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.true;
      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.false;
  
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      
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

      const depositorWsqufuryBalanceBefore = await wSquFury.balanceOf(depositor.address)

      await crabStrategy.connect(depositor).timeHedgeOnUniswap(ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0.0001'));

      const strategyVaultAfter = await controller.vaults(await crabStrategy.vaultId());
      const strategyDebtAfter = strategyVaultAfter.shortAmount
      const depositorWsqufuryBalanceAfter = await wSquFury.balanceOf(depositor.address)
      const ethDeltaAfter = strategyVault.collateralAmount

      expect(isSimilar(expectedEthDeposited.toString(), strategyVaultAfter.collateralAmount.toString()))
      expect(isSimilar((secondTargetHedge.mul(-1)).toString(),(strategyDebtAfter.sub(strategyDebt)).toString()))
      expect(isSimilar((expectedEthProceeds).toString(),ethDeltaAfter.sub(ethDelta).toString()))
      expect(depositorWsqufuryBalanceAfter.gt(depositorWsqufuryBalanceBefore)).to.be.true
    })
  })

  describe("Buy auction", async () => {
    before(async () => {
      // change pool price for auction to be sell auction
      const ethToDeposit = ethers.utils.parseUnits('1000')
      const wSquFuryToMint = ethers.utils.parseUnits('1000')
      const currentBlockTimestamp = (await provider.getBlock(await provider.getBlockNumber())).timestamp
      await controller.connect(owner).mintWPowerPerpAmount("0", wSquFuryToMint, "0", {value: ethToDeposit})
      await buyWeth(swapRouter, wSquFury, weth, owner.address, (await wSquFury.balanceOf(owner.address)), currentBlockTimestamp + 10)
    })
    it("should revert time hedging if the time threshold has not been reached", async () => {  
      const timeAtLastHedge = await crabStrategy.timeAtLastHedge()
      
      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])  
      expect((timeAtLastHedge.add(hedgeTimeThreshold)).gt(hedgeBlockTimestamp)).to.be.true
  
      await expect(
        crabStrategy.connect(depositor).timeHedgeOnUniswap(ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0.0001'))
      ).to.be.revertedWith("Time hedging is not allowed");
    })  

    it("should revert hedging if target hedge sign change (auction change from buying to selling)", async () => {
      await provider.send("evm_increaseTime", [hedgeTimeThreshold + 1])
      await provider.send("evm_mine", [])

      await provider.send("evm_increaseTime", [10])
      await provider.send("evm_mine", [])              

      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 1;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])      

      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(wmul(strategyDebt, BigNumber.from(2).mul(one)), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)        
      const isSellAuction = targetHedge.isNegative()

      expect(isSellAuction).to.be.false

      await expect(
        crabStrategy.connect(depositor).timeHedgeOnUniswap(ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0.0001'))
      ).to.be.revertedWith("auction direction changed");
    })

    it("should revert if not positive PnL", async () => {
      const timeAtLastHedge = await crabStrategy.timeAtLastHedge()
      const hedgeTimeTolerance = await crabStrategy.hedgeTimeThreshold()      
      const auctionTriggerTimer = timeAtLastHedge.add(hedgeTimeTolerance)
      
      // advanced more time to avoid traget hedge sign change
      await provider.send("evm_increaseTime", [auctionTime/3])
      await provider.send("evm_mine", [])        
      
      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 100;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])

      const auctionTimeElapsed = BigNumber.from(hedgeBlockTimestamp).sub(auctionTriggerTimer)
  
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.true;
      expect(await crabStrategy.checkPriceHedge(auctionTriggerTimer)).to.be.false;
  
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(strategyDebt.mul(2), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
      const auctionExecution = (auctionTimeElapsed.gte(BigNumber.from(auctionTime))) ? one : wdiv(auctionTimeElapsed, BigNumber.from(auctionTime))
      const result = calcPriceMulAndAuctionPrice(isSellAuction, maxPriceMultiplier, minPriceMultiplier, auctionExecution, currentWSquFuryPrice)
      const expectedAuctionWSquFuryEthPrice = result[1]

      expect(isSellAuction).to.be.false
      expect(expectedAuctionWSquFuryEthPrice.lt(currentWSquFuryPrice)).to.be.true

      await expect(
        crabStrategy.connect(depositor).timeHedgeOnUniswap(ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0.0001'))
      ).to.be.revertedWith("ds-math-sub-underflow");
    })

    it("hedge based on time on uniswap", async () => {      
      // advanced more time to avoid traget hedge sign change
      await provider.send("evm_increaseTime", [auctionTime])
      await provider.send("evm_mine", [])        
      
      // set next block timestamp
      const currentBlockNumber = await provider.getBlockNumber()
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const hedgeBlockTimestamp = currentBlock.timestamp + 100;
      await provider.send("evm_setNextBlockTimestamp", [hedgeBlockTimestamp])
    
      expect((await crabStrategy.checkTimeHedge())[0]).to.be.true;
  
      const currentWSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const ethDelta = strategyVault.collateralAmount
      const strategyDebt = strategyVault.shortAmount
      const initialWSquFuryDelta = wmul(strategyDebt.mul(2), currentWSquFuryPrice)
      const targetHedge = wdiv(initialWSquFuryDelta.sub(ethDelta), currentWSquFuryPrice)      
      const isSellAuction = targetHedge.isNegative()
  
      expect(isSellAuction).to.be.false
  
      const depositorWsqufuryBalanceBefore = await wSquFury.balanceOf(depositor.address)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)
      
      await crabStrategy.connect(depositor).timeHedgeOnUniswap(ethers.utils.parseUnits('0.01'), ethers.utils.parseUnits('0.0001'));
      
      const depositorWsqufuryBalanceAfter = await wSquFury.balanceOf(depositor.address)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)
  
      expect(depositorEthBalanceAfter.gte(depositorEthBalanceBefore)).to.be.true
      expect(depositorWsqufuryBalanceAfter.eq(depositorWsqufuryBalanceBefore)).to.be.true
    })
  })
})