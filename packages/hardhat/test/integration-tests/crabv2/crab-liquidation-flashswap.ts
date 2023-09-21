import { ethers } from "hardhat"
import { expect } from "chai";
import { Contract, BigNumber, providers } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import BigNumberJs from 'bignumber.js'
import { WETH9, MockErc20, Controller, Oracle, WPowerPerp, CrabStrategyV2, ISwapRouter, Timelock } from "../../../typechain";
import { deployUniswapV3, deploySquFuryCoreContracts, deployWETHAndDai, addWethDaiLiquidity, addSquFuryLiquidity } from '../../setup'
import { isSimilar, wmul, wdiv, one, oracleScaleFactor } from "../../utils"

BigNumberJs.set({ EXPONENTIAL_AT: 30 })

describe("Crab V2 flashswap integration test: crab vault liquidation", function () {
  const startingEthPrice = 3000
  const startingEthPrice1e18 = BigNumber.from(startingEthPrice).mul(one) // 3000 * 1e18
  const scaledStartingSquFuryPrice1e18 = startingEthPrice1e18.mul(11).div(10).div(oracleScaleFactor) // 0.3 * 1e18
  const scaledStartingSquFuryPrice = startingEthPrice * 1.1 / oracleScaleFactor.toNumber() // 0.3


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
  let crabMigration: SignerWithAddress;
  let liquidator: SignerWithAddress;
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
  let crabStrategy: CrabStrategyV2
  let ethDaiPool: Contract
  let timelock: Timelock;

  this.beforeAll("Deploy uniswap protocol & setup uniswap pool", async () => {
    const accounts = await ethers.getSigners();
    const [_owner, _depositor, _depositor2, _liquidator, _feeRecipient, _crabMigration] = accounts;
    owner = _owner;
    depositor = _depositor;
    depositor2 = _depositor2;
    liquidator = _liquidator;
    feeRecipient = _feeRecipient;
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

    await controller.connect(owner).setFeeRecipient(feeRecipient.address);
    await controller.connect(owner).setFeeRate(100)

    const TimelockContract = await ethers.getContractFactory("Timelock");
    timelock = (await TimelockContract.deploy(owner.address, 3 * 24 * 60 * 60)) as Timelock;

    const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
    crabStrategy = (await CrabStrategyContract.deploy(controller.address, oracle.address, weth.address, uniswapFactory.address, wSquFuryPool.address, timelock.address, crabMigration.address, hedgeTimeThreshold, hedgePriceThreshold)) as CrabStrategyV2;
  })

  this.beforeAll("Seed pool liquidity", async () => {
    await provider.send("evm_increaseTime", [300])
    await provider.send("evm_mine", [])

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
    const depositorSquFuryBalanceBefore = await wSquFury.balanceOf(depositor.address)
    const currentScaledSqfuryPrice = (await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 300, false))
    const feeRate = await controller.feeRate()
    const ethFeePerWSquFury = currentScaledSqfuryPrice.mul(feeRate).div(10000)
    const squfuryDelta = scaledStartingSquFuryPrice1e18.mul(2);
    const debtToMint = wdiv(ethToDeposit, (squfuryDelta.add(ethFeePerWSquFury)));
    const expectedEthDeposit = ethToDeposit.sub(debtToMint.mul(ethFeePerWSquFury).div(one))
    const strategyCap = ethers.utils.parseUnits("1000")

    await crabStrategy.connect(crabMigration).initialize(debtToMint, expectedEthDeposit, 0, 0, strategyCap, { value: ethToDeposit });
    const strategyCapInContract = await crabStrategy.strategyCap()
    expect(strategyCapInContract.eq(strategyCap)).to.be.true

    await crabStrategy.connect(crabMigration).transfer(depositor.address, expectedEthDeposit);

    const totalSupply = (await crabStrategy.totalSupply())
    const depositorCrab = (await crabStrategy.balanceOf(depositor.address))
    const strategyVault = await controller.vaults(await crabStrategy.vaultId());
    const debtAmount = strategyVault.shortAmount
    const depositorSquFuryBalance = await wSquFury.balanceOf(depositor.address)
    const strategyContractSquFury = await wSquFury.balanceOf(crabStrategy.address)

    expect(isSimilar(totalSupply.toString(),(expectedEthDeposit).toString())).to.be.true
    expect(isSimilar(depositorCrab.toString(), expectedEthDeposit.toString())).to.be.true
    expect(isSimilar(debtAmount.toString(), debtToMint.toString())).to.be.true
    expect(depositorSquFuryBalance.eq(depositorSquFuryBalanceBefore)).to.be.true
    expect(strategyContractSquFury.eq(BigNumber.from(0))).to.be.true
  })

  describe("liquidate vault", async () => {
    before('push weth price higher to make crab vault liquidatable', async () => {
      // set weth price higher by buying 25% of weth in the pool
      const poolWethBalance = await weth.balanceOf(ethDaiPool.address)

      const maxDai = poolWethBalance.mul(startingEthPrice).mul(5)

      const exactOutputParam = {
        tokenIn: dai.address,
        tokenOut: weth.address,
        fee: 3000,
        recipient: owner.address,
        deadline: (await provider.getBlock(await provider.getBlockNumber())).timestamp + 86400,
        amountOut: ethers.utils.parseUnits("20"),
        amountInMaximum: maxDai,
        sqrtPriceLimitX96: 0,
      }

      await dai.connect(owner).mint(owner.address, maxDai,)
      await dai.connect(owner).approve(swapRouter.address, ethers.constants.MaxUint256)
      await (swapRouter as ISwapRouter).connect(owner).exactOutputSingle(exactOutputParam)
    })

    before('push squfury price higher', async () => {
      // set squfury price higher by buying 25% of squfury in the pool
      const poolSquFuryBalance = await wSquFury.balanceOf(wSquFuryPool.address)

      const maxWeth = poolSquFuryBalance.mul(scaledStartingSquFuryPrice1e18).mul(5).div(one)

      const exactOutputParam = {
        tokenIn: weth.address,
        tokenOut: wSquFury.address,
        fee: 3000,
        recipient: owner.address,
        deadline: (await provider.getBlock(await provider.getBlockNumber())).timestamp + 86400,
        amountOut: ethers.utils.parseUnits("200000"),
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
      await controller.connect(liquidator).mintPowerPerpAmount(0, mintAmount, 0, { value: collateralRequired })
    })

    it("should liquidate crab vault", async () => {
      const vaultId = await crabStrategy.vaultId();
      const isVaultSafe = await controller.isVaultSafe((await crabStrategy.vaultId()))
      const normFactor = await controller.getExpectedNormalizationFactor()
      const newEthPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 600, false)
      const newSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const vaultBefore = await controller.vaults(vaultId)
      const wSquFuryVaultBefore = vaultBefore.shortAmount
      const collateralBefore = vaultBefore.collateralAmount

      const collatRatio = collateralBefore.mul(one).div(wSquFuryVaultBefore.mul(normFactor).mul(newEthPrice).div(one).div(one).div(oracleScaleFactor))

      expect(isVaultSafe).to.be.false

      // state before liquidation
      const liquidatorSquFuryBefore = await wSquFury.balanceOf(liquidator.address)
      const liquidatorBalanceBefore = await provider.getBalance(liquidator.address)

      const wSquFuryAmountToLiquidate = vaultBefore.shortAmount.div(2)

      await controller.connect(liquidator).liquidate(vaultId, wSquFuryAmountToLiquidate);

      const collateralToGet = newSquFuryPrice.mul(wSquFuryAmountToLiquidate).div(one).mul(11).div(10)

      const vaultAfter = await controller.vaults(vaultId)
      const liquidatorBalanceAfter = await provider.getBalance(liquidator.address)
      const liquidatorSquFuryAfter = await wSquFury.balanceOf(liquidator.address)

      expect(isSimilar((vaultBefore.shortAmount.div(2)).toString(), (vaultAfter.shortAmount).toString())).to.be.true
      expect(vaultAfter.shortAmount.gt(BigNumber.from(0))).to.be.true
      expect(vaultAfter.collateralAmount.gt(BigNumber.from(0))).to.be.true
      // expect(collateralToGet.eq(liquidatorBalanceAfter.sub(liquidatorBalanceBefore))).to.be.true
      expect(vaultBefore.shortAmount.sub(vaultAfter.shortAmount).eq(liquidatorSquFuryBefore.sub(liquidatorSquFuryAfter))).to.be.true
    })

    it("should let user deposit post liquidation and update vault state and provide correct wSquFury and crab tokens", async () => {

      //                               (userEthDeposit * strategyDebtBeforeDeposit) 
      //  wSquFuryToMint =  ----------------------------------------------------------------------------------------
      //                    (strategyCollateralBeforeDeposit + strategyDebtBeforeDeposit*squfuryEthPrice*fee%)


      const vaultId = await crabStrategy.vaultId();
      const isVaultSafe = await controller.isVaultSafe((await crabStrategy.vaultId()))
      const normFactor = await controller.getExpectedNormalizationFactor()
      const newEthPrice = await oracle.getTwap(ethDaiPool.address, weth.address, dai.address, 600, false)
      const newSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 600, false)
      const vaultBefore = await controller.vaults(vaultId)
      const wSquFuryVaultBefore = vaultBefore.shortAmount
      const collateralBefore = vaultBefore.collateralAmount

      const collatRatio = collateralBefore.mul(one).div(wSquFuryVaultBefore.mul(normFactor).mul(newEthPrice).div(one).div(one).div(oracleScaleFactor))

      const debtBefore = vaultBefore.shortAmount
      const ratio = debtBefore.mul(one).div(collateralBefore)

      const ethToDeposit = ethers.utils.parseUnits('20')
      const msgvalue = ethers.utils.parseUnits('15')
      const totalSupplyBefore = (await crabStrategy.totalSupply())
      const depositorCrabBefore = (await crabStrategy.balanceOf(depositor2.address))
      const depositorSquFuryBalanceBefore = await wSquFury.balanceOf(depositor.address)

      await crabStrategy.connect(depositor2).flashDeposit(ethToDeposit, poolFee, { value: msgvalue })

      const currentScaledSqfuryPrice = (await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 300, false))
      const feeRate = await controller.feeRate()
      const ethFeePerWSquFury = currentScaledSqfuryPrice.mul(feeRate).div(10000)
      const debtToMint = ethToDeposit.mul(debtBefore).div(collateralBefore.add(debtBefore.mul(ethFeePerWSquFury).div(one)))
      const expectedEthDeposit = ethToDeposit.sub(debtToMint.mul(ethFeePerWSquFury).div(one))
      const depositorShare = one.mul(expectedEthDeposit).div(collateralBefore.add(expectedEthDeposit))
      const crabMintAmount = totalSupplyBefore.mul(depositorShare).div(one.sub(depositorShare))

      const strategyVaultAfter = await controller.vaults(vaultId)
      const strategyDebtAmountAfter = strategyVaultAfter.shortAmount
      const strategyCollateralAmountAfter = strategyVaultAfter.collateralAmount
      const depositorCrabAfter = (await crabStrategy.balanceOf(depositor2.address))
      const depositorSquFuryBalanceAfter = await wSquFury.balanceOf(depositor2.address)
      const strategyContractSquFury = await wSquFury.balanceOf(crabStrategy.address)
      const totalSupplyAfter = (await crabStrategy.totalSupply())
      // const depositorEthBalanceAfter = await provider.getBalance(depositor2.address)

      expect(isSimilar((strategyCollateralAmountAfter.sub(collateralBefore)).toString(), (expectedEthDeposit).toString())).to.be.true
      expect(isSimilar(strategyDebtAmountAfter.toString(), (debtBefore.add(debtToMint)).toString())).to.be.true
      expect(isSimilar((strategyDebtAmountAfter.sub(debtBefore)).toString(), (debtToMint).toString())).to.be.true
      expect(isSimilar((totalSupplyAfter.sub(totalSupplyBefore)).toString(), (crabMintAmount).toString())).to.be.true
      expect((depositorSquFuryBalanceAfter.sub(depositorSquFuryBalanceBefore)).eq(BigNumber.from(0))).to.be.true
      expect(strategyContractSquFury.eq(BigNumber.from(0))).to.be.true
      expect(isSimilar((depositorCrabAfter.sub(depositorCrabBefore)).toString(), (crabMintAmount).toString())).to.be.true
    })

    it("depositor should withdraw correct amount of ETH collateral", async () => {
      const wSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 1, false)

      const userCrabBalanceBefore = await crabStrategy.balanceOf(depositor.address);
      const crabTotalSupply = await crabStrategy.totalSupply()
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const strategyDebtAmountBefore = strategyVault.shortAmount
      const strategyCollateralAmountBefore = strategyVault.collateralAmount
      const userEthBalanceBefore = await provider.getBalance(depositor.address)
      const crabRatio = wdiv(userCrabBalanceBefore, crabTotalSupply);
      const debtToRepay = wmul(crabRatio, strategyDebtAmountBefore);
      const ethCostOfDebtToRepay = wmul(debtToRepay, wSquFuryPrice)
      const userCollateral = wmul(crabRatio, strategyCollateralAmountBefore)
      const ethToWithdraw = userCollateral.sub(ethCostOfDebtToRepay);
      const maxEthToPay = ethCostOfDebtToRepay.mul(101).div(100)

      await crabStrategy.connect(depositor).flashWithdraw(userCrabBalanceBefore, maxEthToPay, poolFee)

      const userEthBalanceAfter = await provider.getBalance(depositor.address)
      const userCrabBalanceAfter = await crabStrategy.balanceOf(depositor.address);
      const vaultId = await crabStrategy.vaultId();
      const isVaultSafe = await controller.isVaultSafe((await crabStrategy.vaultId()))
      expect(isVaultSafe).to.be.true

      const vaultBefore = await controller.vaults(vaultId)
      const collateralAfter = vaultBefore.collateralAmount
      const debtAfter = vaultBefore.shortAmount

      expect(isSimilar(userEthBalanceAfter.sub(userEthBalanceBefore).toString(), ethToWithdraw.toString(), 2)).to.be.true
      expect(userCrabBalanceAfter.eq(BigNumber.from(0))).to.be.true
      expect(userCrabBalanceBefore.sub(userCrabBalanceAfter).eq(userCrabBalanceBefore)).to.be.true
      expect(collateralAfter.eq(strategyCollateralAmountBefore.sub(userCollateral))).to.be.true
      // use isSimilar to prevent last digits rounding error
      expect(isSimilar(strategyDebtAmountBefore.sub(debtAfter).toString(), debtToRepay.toString(), 10)).to.be.true
    })

    it("depositor2 should withdraw correct amount of ETH collateral", async () => {


      const wSquFuryPrice = await oracle.getTwap(wSquFuryPool.address, wSquFury.address, weth.address, 1, false)

      const userCrabBalanceBefore = await crabStrategy.balanceOf(depositor2.address);
      const crabTotalSupply = await crabStrategy.totalSupply()
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const strategyDebtAmountBefore = strategyVault.shortAmount
      const strategyCollateralAmountBefore = strategyVault.collateralAmount
      const userEthBalanceBefore = await provider.getBalance(depositor2.address)
      const crabRatio = wdiv(userCrabBalanceBefore, crabTotalSupply);
      const debtToRepay = wmul(crabRatio, strategyDebtAmountBefore);
      const ethCostOfDebtToRepay = wmul(debtToRepay, wSquFuryPrice)
      const userCollateral = wmul(crabRatio, strategyCollateralAmountBefore)
      const ethToWithdraw = userCollateral.sub(ethCostOfDebtToRepay);
      const maxEthToPay = ethCostOfDebtToRepay.mul(11).div(10)

      await crabStrategy.connect(depositor2).flashWithdraw(userCrabBalanceBefore, maxEthToPay, poolFee)

      const strategyVaultAfter = await controller.vaults(await crabStrategy.vaultId());
      const userEthBalanceAfter = await provider.getBalance(depositor2.address)
      const userCrabBalanceAfter = await crabStrategy.balanceOf(depositor2.address);
      const strategyDebtAmountAfter = strategyVaultAfter.shortAmount
      const strategyCollateralAmountAfter = strategyVaultAfter.collateralAmount

      const vaultId = await crabStrategy.vaultId();
      const isVaultSafe = await controller.isVaultSafe((await crabStrategy.vaultId()))
      expect(isVaultSafe).to.be.true

      const vaultBefore = await controller.vaults(vaultId)
      const collateralAfter = vaultBefore.collateralAmount
      const debtAfter = vaultBefore.shortAmount

      expect(isSimilar(userEthBalanceAfter.sub(userEthBalanceBefore).toString(), ethToWithdraw.toString(), 2)).to.be.true
      expect(userCrabBalanceAfter.eq(BigNumber.from(0))).to.be.true
      expect(userCrabBalanceBefore.sub(userCrabBalanceAfter).eq(userCrabBalanceBefore)).to.be.true
      expect(collateralAfter.eq(strategyCollateralAmountBefore.sub(userCollateral))).to.be.true
      expect(strategyDebtAmountBefore.sub(debtAfter).eq(debtToRepay)).to.be.true
      expect(strategyDebtAmountAfter.eq(BigNumber.from(0))).to.be.true
      expect(strategyCollateralAmountAfter.eq(BigNumber.from(0))).to.be.true
    })
  })
})