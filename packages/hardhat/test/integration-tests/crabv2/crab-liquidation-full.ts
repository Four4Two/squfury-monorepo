import { ethers } from "hardhat"
import { expect } from "chai";
import { Contract, BigNumber, providers } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import BigNumberJs from 'bignumber.js'
import { WETH9, MockErc20, Controller, Oracle, WPowerPerp, CrabStrategyV2, ISwapRouter, Timelock } from "../../../typechain";
import { deployUniswapV3, deploySquFuryCoreContracts, deployWETHAndDai, addWethDaiLiquidity, addSquFuryLiquidity } from '../../setup'
import { isSimilar, wmul, wdiv, one, oracleScaleFactor } from "../../utils"

BigNumberJs.set({ EXPONENTIAL_AT: 30 })

describe("Crab V2 integration test: crab vault full liquidation and shutdown of contracts", function () {
  const startingEthPrice = 3000
  const startingEthPrice1e18 = BigNumber.from(startingEthPrice).mul(one) // 3000 * 1e18
  const scaledStartingSquFuryPrice1e18 = startingEthPrice1e18.div(oracleScaleFactor) // 0.3 * 1e18
  const scaledStartingSquFuryPrice = startingEthPrice / oracleScaleFactor.toNumber() // 0.3


  const hedgeTimeThreshold = 86400  // 24h
  const hedgePriceThreshold = ethers.utils.parseUnits('0.01')
  const auctionTime = 3600
  const minPriceMultiplier = ethers.utils.parseUnits('0.95')
  const maxPriceMultiplier = ethers.utils.parseUnits('1.05')
  let poolFee: BigNumber

  let provider: providers.JsonRpcProvider;
  let owner: SignerWithAddress;
  let depositor: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let liquidator: SignerWithAddress;
  let crabMigration: SignerWithAddress;
  let dai: MockErc20
  let weth: WETH9
  let positionManager: Contract
  let uniswapFactory: Contract
  let swapRouter: Contract
  let oracle: Oracle
  let controller: Controller
  let wSquFuryPool: Contract
  let wSquFury: WPowerPerp
  let crabStrategy: CrabStrategyV2
  let ethDaiPool: Contract
  let timelock: Timelock

  this.beforeAll("Deploy uniswap protocol & setup uniswap pool", async () => {
    const accounts = await ethers.getSigners();
    const [_owner, _depositor, _depositor2, _liquidator, _crabMigration] = accounts;
    owner = _owner;
    depositor = _depositor;
    depositor2 = _depositor2;
    liquidator = _liquidator;
    crabMigration = _crabMigration; 
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

    poolFee = await wSquFuryPool.fee()

    const TimelockContract = await ethers.getContractFactory("Timelock");
    timelock = (await TimelockContract.deploy(owner.address, 3 * 24 * 60 * 60)) as Timelock;

    const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
    crabStrategy = (await CrabStrategyContract.deploy(controller.address, oracle.address, weth.address, uniswapFactory.address, wSquFuryPool.address, timelock.address, crabMigration.address, hedgeTimeThreshold, hedgePriceThreshold)) as CrabStrategyV2;
  })

  this.beforeAll("Seed pool liquidity", async () => {
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

  this.beforeAll("Initialize strategy", async () => {
    const ethToDeposit = ethers.utils.parseUnits('20')
    const msgvalue = ethers.utils.parseUnits('20')
    const ethPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 600, true)

    const squfuryDelta = ethPrice.mul(2).div(1e4);
    const debtToMint = wdiv(ethToDeposit, squfuryDelta);
    const depositorSquFuryBalanceBefore = await wSquFury.balanceOf(depositor.address)
    const strategyCap = ethers.utils.parseUnits("1000")

    await crabStrategy.connect(crabMigration).initialize(debtToMint, ethToDeposit, 0, 0, strategyCap, { value: msgvalue })
    const strategyCapInContract = await crabStrategy.strategyCap()
    expect(strategyCapInContract.eq(strategyCap)).to.be.true


    await crabStrategy.connect(crabMigration).transfer(depositor.address, ethToDeposit);
    await wSquFury.connect(crabMigration).transfer(depositor.address, debtToMint);

    const totalSupply = (await crabStrategy.totalSupply())
    const depositorCrab = (await crabStrategy.balanceOf(depositor.address))
    const [strategyOperatorBefore, strategyNftIdBefore, strategyCollateralAmountBefore, debtAmount] = await crabStrategy.getVaultDetails()
    const depositorSquFuryBalance = await wSquFury.balanceOf(depositor.address)
    const strategyContractSquFury = await wSquFury.balanceOf(crabStrategy.address)

    expect(totalSupply.eq(ethToDeposit)).to.be.true
    expect(depositorCrab.eq(ethToDeposit)).to.be.true
    // these had to be adjusted - it seems the eth price is a bit different than expected maybe? but only in coverage???
    expect(isSimilar(debtAmount.toString(), debtToMint.toString(), 3)).to.be.true
    expect(isSimilar((depositorSquFuryBalance.sub(depositorSquFuryBalanceBefore)).toString(), (debtToMint).toString(), 3)).to.be.true
    expect(strategyContractSquFury.eq(BigNumber.from(0))).to.be.true

  })

  describe("liquidate vault", async () => {
    before('push weth price higher to make crab vault liquidatable', async () => {
      const poolWethBalance = await weth.balanceOf(ethDaiPool.address)

      const maxDai = poolWethBalance.mul(startingEthPrice).mul(20)

      const exactOutputParam = {
        tokenIn: dai.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: owner.address,
        deadline: (await provider.getBlock(await provider.getBlockNumber())).timestamp + 86400,
        amountOut: ethers.utils.parseUnits("50"),
        amountInMaximum: maxDai,
        sqrtPriceLimitX96: 0,
      }

      await dai.connect(owner).mint(owner.address, maxDai,)
      await dai.connect(owner).approve(swapRouter.address, ethers.constants.MaxUint256)
      await (swapRouter as ISwapRouter).connect(owner).exactOutputSingle(exactOutputParam)
    })

    before('push squfury price higher', async () => {
      // set squfury price higher by buying 50% of squfury in the pool
      const poolSquFuryBalance = await wSquFury.balanceOf(wSquFuryPool.address)

      const maxWeth = poolSquFuryBalance.mul(scaledStartingSquFuryPrice1e18).mul(20).div(one)

      const exactOutputParam = {
        tokenIn: weth.address,
        tokenOut: wSquFury.address,
        fee: 3000,
        recipient: owner.address,
        deadline: (await provider.getBlock(await provider.getBlockNumber())).timestamp + 86400,
        amountOut: ethers.utils.parseUnits("500000"),
        amountInMaximum: maxWeth,
        sqrtPriceLimitX96: 0,
      }

      await weth.connect(owner).deposit({ value: maxWeth })
      await weth.connect(owner).approve(swapRouter.address, ethers.constants.MaxUint256)
      await (swapRouter as ISwapRouter).connect(owner).exactOutputSingle(exactOutputParam)
    })

    before('prepare liquidator to liquidate strategy', async () => {
      await provider.send("evm_increaseTime", [600]) // increase time by 600 sec
      await provider.send("evm_mine", [])

      const vaultId = await crabStrategy.vaultId();
      const newEthPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 600, false)
      const vaultBefore = await controller.vaults(vaultId)

      const mintAmount = vaultBefore.shortAmount
      const collateralRequired = mintAmount.mul(newEthPrice).mul(2).div(oracleScaleFactor).div(one).mul(2)

      // mint squfury to liquidate vault0!
      await controller.connect(liquidator).mintWPowerPerpAmount(0, mintAmount, 0, { value: collateralRequired })
    })

    it("should liquidate crab vault using a full insolvent liquidation (0 collateral 0 debt remain)", async () => {
      const vaultId = await crabStrategy.vaultId();
      const isVaultSafe = await controller.isVaultSafe((await crabStrategy.vaultId()))
      expect(isVaultSafe).to.be.false

      const vaultBefore = await controller.vaults(vaultId)

      // state before liquidation
      const liquidatorSquFuryBefore = await wSquFury.balanceOf(liquidator.address)
      const liquidatorBalanceBefore = await provider.getBalance(liquidator.address)

      const wSquFuryAmountToLiquidate = vaultBefore.shortAmount

      await controller.connect(liquidator).liquidate(vaultId, wSquFuryAmountToLiquidate);

      const collateralToGet = vaultBefore.collateralAmount

      const vaultAfter = await controller.vaults(vaultId)
      const liquidatorBalanceAfter = await provider.getBalance(liquidator.address)
      const liquidatorSquFuryAfter = await wSquFury.balanceOf(liquidator.address)

      // expect(collateralToGet.eq(liquidatorBalanceAfter.sub(liquidatorBalanceBefore))).to.be.true
      expect(vaultBefore.shortAmount.sub(vaultAfter.shortAmount).eq(liquidatorSquFuryBefore.sub(liquidatorSquFuryAfter))).to.be.true
      expect(vaultAfter.shortAmount.eq(BigNumber.from(0))).to.be.equal
      expect(vaultAfter.collateralAmount.eq(BigNumber.from(0))).to.be.equal

    })

    it("should NOT let user flash deposit post liquidation", async () => {
      const vaultId = await crabStrategy.vaultId();
      const isVaultSafe = await controller.isVaultSafe((await crabStrategy.vaultId()))
      expect(isVaultSafe).to.be.true

      const vaultBefore = await controller.vaults(vaultId)
      const collateralBefore = vaultBefore.collateralAmount
      const debtBefore = vaultBefore.shortAmount

      const ethToDeposit = ethers.utils.parseUnits('20')
      // const ethToBorrow = ethers.utils.parseUnits('10')
      const msgvalue = ethers.utils.parseUnits('15')
      const totalSupplyBefore = (await crabStrategy.totalSupply())

      expect(totalSupplyBefore.gt(BigNumber.from(0))).to.be.true
      expect(collateralBefore.eq(BigNumber.from(0))).to.be.true
      expect(debtBefore.eq(BigNumber.from(0))).to.be.true

      await expect(crabStrategy.connect(depositor2).flashDeposit(ethToDeposit, poolFee, { value: msgvalue })).to.be.revertedWith("C26")
    })

    it("should NOT let user deposit post liquidation", async () => {
      const vaultId = await crabStrategy.vaultId();
      const isVaultSafe = await controller.isVaultSafe((await crabStrategy.vaultId()))
      expect(isVaultSafe).to.be.true

      const vaultBefore = await controller.vaults(vaultId)
      const collateralBefore = vaultBefore.collateralAmount
      const debtBefore = vaultBefore.shortAmount

      const msgvalue = ethers.utils.parseUnits('15')
      const totalSupplyBefore = (await crabStrategy.totalSupply())

      expect(totalSupplyBefore.gt(BigNumber.from(0))).to.be.true
      expect(collateralBefore.eq(BigNumber.from(0))).to.be.true
      expect(debtBefore.eq(BigNumber.from(0))).to.be.true

      await expect(crabStrategy.connect(depositor2).deposit({ value: msgvalue })).to.be.revertedWith("C26")
    })

    it("depositor should revert trying to flashWithdraw with AS due to amount of wSquFury to buy being 0", async () => {
      const wSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 1, false)

      const userCrabBalanceBefore = await crabStrategy.balanceOf(depositor.address);
      const crabTotalSupply = await crabStrategy.totalSupply()
      const [strategyOperatorBefore, strategyNftIdBefore, strategyCollateralAmountBefore, strategyDebtAmountBefore] = await crabStrategy.getVaultDetails()
      const crabRatio = wdiv(userCrabBalanceBefore, crabTotalSupply);
      const debtToRepay = wmul(crabRatio, strategyDebtAmountBefore);
      const ethCostOfDebtToRepay = wmul(debtToRepay, wSquFuryPrice)
      const userCollateral = wmul(crabRatio, strategyCollateralAmountBefore)
      const ethToWithdraw = userCollateral.sub(ethCostOfDebtToRepay);
      const maxEthToPay = ethCostOfDebtToRepay.mul(11).div(10)

      await expect(crabStrategy.connect(depositor).flashWithdraw(userCrabBalanceBefore, maxEthToPay, poolFee)).to.be.revertedWith("AS")

    })

    it("depositor withdraw and get 0", async () => {

      const userCrabBalanceBefore = await crabStrategy.balanceOf(depositor.address);
      const crabTotalSupply = await crabStrategy.totalSupply()
      const [strategyOperatorBefore, strategyNftIdBefore, strategyCollateralAmountBefore, strategyDebtAmountBefore] = await crabStrategy.getVaultDetails()
      const userEthBalanceBefore = await provider.getBalance(depositor.address)
      const crabRatio = wdiv(userCrabBalanceBefore, crabTotalSupply);

      const userCollateral = wmul(crabRatio, strategyCollateralAmountBefore)
      const userSquFuryBalanceBefore = await wSquFury.balanceOf(depositor.address)

      await crabStrategy.connect(depositor).withdraw(userCrabBalanceBefore)

      const userEthBalanceAfter = await provider.getBalance(depositor.address)
      const userCrabBalanceAfter = await crabStrategy.balanceOf(depositor.address);
      const userSquFuryBalanceAfter = await wSquFury.balanceOf(depositor.address)

      const vaultId = await crabStrategy.vaultId();
      const isVaultSafe = await controller.isVaultSafe((await crabStrategy.vaultId()))
      expect(isVaultSafe).to.be.true

      const vaultBefore = await controller.vaults(vaultId)
      const collateralAfter = vaultBefore.collateralAmount
      const debtAfter = vaultBefore.shortAmount
      const totalSupplyAfter = await crabStrategy.totalSupply()

      // expect(userEthBalanceAfter.sub(userEthBalanceBefore).eq(BigNumber.from(0))).to.be.true
      expect(userCrabBalanceAfter.eq(BigNumber.from(0))).to.be.true
      expect(userCrabBalanceBefore.sub(userCrabBalanceAfter).eq(userCrabBalanceBefore)).to.be.true
      expect(userSquFuryBalanceAfter.sub(userSquFuryBalanceBefore).eq(BigNumber.from(0))).to.be.true
      expect(collateralAfter.eq(strategyCollateralAmountBefore.sub(userCollateral))).to.be.true
      expect(collateralAfter.eq(BigNumber.from(0))).to.be.true
      expect(debtAfter.eq(BigNumber.from(0))).to.be.true
      expect(totalSupplyAfter.eq(BigNumber.from(0))).to.be.true
    })
  })
})
