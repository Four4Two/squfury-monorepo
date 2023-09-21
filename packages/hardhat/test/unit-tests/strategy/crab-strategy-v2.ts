import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { ethers } from "hardhat"
import { expect } from "chai";
import { BigNumber, providers } from "ethers";
import { MockController, WETH9, MockShortPowerPerp, MockUniswapV3Pool, MockOracle, MockWPowerPerp, CrabStrategyV2, MockErc20, MockTimelock } from "../../../typechain";
import { isSimilar, wmul, wdiv, one, oracleScaleFactor } from "../../utils"

describe("Crab Strategy V2", function () {
  const hedgeTimeTolerance = 86400  // 24h
  const hedgePriceTolerance = ethers.utils.parseUnits('0.15')

  let provider: providers.JsonRpcProvider;
  let owner: SignerWithAddress;
  let random: SignerWithAddress;
  let depositor: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let crabMigration: SignerWithAddress;

  let squfury: MockWPowerPerp;
  let weth: WETH9;
  let wSquFuryEthPool: MockUniswapV3Pool;
  let ethUSDPool: MockUniswapV3Pool;
  let shortSquFury: MockShortPowerPerp;
  let controller: MockController;
  let oracle: MockOracle;
  let crabStrategy: CrabStrategyV2;
  let usdc: MockErc20;
  let timelock: MockTimelock;

  this.beforeAll("Prepare accounts", async () => {
    const accounts = await ethers.getSigners();
    const [_owner, _depositor, _random, _depositor2, _crabMigration] = accounts;
    depositor = _depositor
    depositor2 = _depositor2
    random = _random
    owner = _owner
    crabMigration = _crabMigration
    provider = ethers.provider
  })

  this.beforeAll("Setup environment", async () => {
    const WETH9Contract = await ethers.getContractFactory("WETH9");
    weth = (await WETH9Contract.deploy()) as WETH9;

    const MockSQUContract = await ethers.getContractFactory("MockWPowerPerp");
    squfury = (await MockSQUContract.deploy()) as MockWPowerPerp;

    const MockUniswapV3PoolContract = await ethers.getContractFactory("MockUniswapV3Pool");
    wSquFuryEthPool = (await MockUniswapV3PoolContract.deploy()) as MockUniswapV3Pool;
    ethUSDPool = (await MockUniswapV3PoolContract.deploy()) as MockUniswapV3Pool;

    const MockErc20Contract = await ethers.getContractFactory("MockErc20");
    usdc = (await MockErc20Contract.deploy("USDC", "USDC", 6)) as MockErc20;

    const MockOracle = await ethers.getContractFactory("MockOracle");
    oracle = (await MockOracle.deploy()) as MockOracle;

    const NFTContract = await ethers.getContractFactory("MockShortPowerPerp");
    shortSquFury = (await NFTContract.deploy()) as MockShortPowerPerp;

    const ControllerContract = await ethers.getContractFactory("MockController");
    controller = (await ControllerContract.deploy()) as MockController;

    const TimelockContract = await ethers.getContractFactory("MockTimelock");
    timelock = (await TimelockContract.deploy(owner.address, 3 * 24 * 60 * 60)) as MockTimelock;


    await controller.connect(owner).init(shortSquFury.address, squfury.address, ethUSDPool.address, usdc.address);
  })

  describe("Deployment", async () => {

    it("Should revert if weth is address 0", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      await expect(CrabStrategyContract.deploy(
        controller.address,
        oracle.address,
        ethers.constants.AddressZero,
        random.address,
        wSquFuryEthPool.address,
        timelock.address,
        crabMigration.address,
        hedgeTimeTolerance,
        hedgePriceTolerance)).to.be.revertedWith("invalid weth address");
    });

    it("Should revert if controller is address 0", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      await expect(CrabStrategyContract.deploy(
        ethers.constants.AddressZero,
        oracle.address,
        weth.address,
        random.address,
        wSquFuryEthPool.address,
        timelock.address,
        crabMigration.address,
        hedgeTimeTolerance,
        hedgePriceTolerance)).to.be.revertedWith("invalid controller address");
    });

    it("Should revert if oracle is address 0", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      await expect(CrabStrategyContract.deploy(
        controller.address,
        ethers.constants.AddressZero,
        weth.address,
        random.address,
        wSquFuryEthPool.address,
        timelock.address,
        crabMigration.address,
        hedgeTimeTolerance,
        hedgePriceTolerance)).to.be.revertedWith("C3");
    });

    it("Should revert if uniswap factory is address 0", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      await expect(CrabStrategyContract.deploy(
        controller.address,
        oracle.address,
        weth.address,
        ethers.constants.AddressZero,
        wSquFuryEthPool.address,
        timelock.address,
        crabMigration.address,
        hedgeTimeTolerance,
        hedgePriceTolerance)).to.be.revertedWith("invalid factory address");
    });

    it("Should revert if wSquFuryEth pool is address 0", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      await expect(CrabStrategyContract.deploy(
        controller.address,
        oracle.address,
        weth.address,
        random.address,
        ethers.constants.AddressZero,
        timelock.address,
        crabMigration.address,
        hedgeTimeTolerance,
        hedgePriceTolerance)).to.be.revertedWith("C5");
    });

    it("Should revert if hedge time tolerrance is 0", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      await expect(CrabStrategyContract.deploy(
        controller.address,
        oracle.address,
        weth.address,
        random.address,
        wSquFuryEthPool.address,
        timelock.address,
        crabMigration.address,
        0,
        hedgePriceTolerance)).to.be.revertedWith("C7");
    });

    it("Should revert if hedge price tolerance is 0", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      await expect(CrabStrategyContract.deploy(
        controller.address,
        oracle.address,
        weth.address,
        random.address,
        wSquFuryEthPool.address,
        timelock.address,
        crabMigration.address,
        hedgeTimeTolerance,
        0)).to.be.revertedWith("C8");
    });

    it("Should revert if hedge price tolerance is > 1e18", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      await expect(CrabStrategyContract.deploy(
        controller.address,
        oracle.address,
        weth.address,
        random.address,
        wSquFuryEthPool.address,
        timelock.address,
        crabMigration.address,
        hedgeTimeTolerance,
        one.add(1))).to.be.revertedWith("C8");
    });

    it("Should revert if timelock address is 0", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      await expect(CrabStrategyContract.deploy(
        controller.address,
        oracle.address,
        weth.address,
        random.address,
        wSquFuryEthPool.address,
        ethers.constants.AddressZero,
        crabMigration.address,
        hedgeTimeTolerance,
        hedgePriceTolerance)).to.be.revertedWith("C4");
    });

    it("Should revert if crab migration address is 0", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      await expect(CrabStrategyContract.deploy(
        controller.address,
        oracle.address,
        weth.address,
        random.address,
        wSquFuryEthPool.address,
        timelock.address,
        ethers.constants.AddressZero,
        hedgeTimeTolerance,
        hedgePriceTolerance)).to.be.revertedWith("C6");
    });

    it("Deployment", async function () {
      const CrabStrategyContract = await ethers.getContractFactory("CrabStrategyV2");
      crabStrategy = (await CrabStrategyContract.deploy(controller.address, oracle.address, weth.address, random.address, wSquFuryEthPool.address, timelock.address, crabMigration.address, hedgeTimeTolerance, hedgePriceTolerance)) as CrabStrategyV2;
    });
  });

  describe("Crab strategy vault", async () => {
    it("Check crab details", async () => {
      const name = await crabStrategy.name()
      const symbol = await crabStrategy.symbol()

      expect(name).to.be.eq("Crab Strategy v2")
      expect(symbol).to.be.eq("Crabv2")
    })
    it("Check crab strategy opened vault", async () => {
      const openedVaultId = await crabStrategy.getStrategyVaultId()

      expect(openedVaultId).to.be.eq(BigNumber.from(1))
    });
  });

  describe("receive checks", async () => {
    it('should revert when sending eth to crab strategy contract from an EOA', async () => {
      await expect(random.sendTransaction({ to: crabStrategy.address, value: 1 })).to.be.revertedWith('C9')
    })
  });

  describe("Check pre initialization strategy cap reverts", async () => {
    const strategyCap = ethers.utils.parseUnits("100")
    const wSquFuryEthPrice = BigNumber.from('3030').mul(one).div(oracleScaleFactor)
    const ethUSDPrice = BigNumber.from('3000').mul(one)

    before(async () => {
      await oracle.connect(owner).setPrice(wSquFuryEthPool.address, wSquFuryEthPrice)
      await oracle.connect(random).setPrice(ethUSDPool.address, ethUSDPrice)  // usdc per 1 eth
    })

    it('should revert non owner tries to set the strategy cap', async () => {
      await expect(crabStrategy.connect(random).setStrategyCap(strategyCap)).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it('should revert if owner tries to increase the strategy cap before the contract is initialized', async () => {
      await expect(crabStrategy.connect(owner).setStrategyCap(strategyCap)).to.be.revertedWith("C2")
    })
  });

  describe("set other params", async () => {

    const newHedgeTimeTolerance = 172800  // 48h
    const newHedgePriceTolerance = ethers.utils.parseUnits('0.1')
    const newAuctionTime = 1200
    const newMinAuctionSlippage = ethers.utils.parseUnits('0.9')
    const revertMinAuctionSlippage = ethers.utils.parseUnits('1')
    const newMaxAuctionSlippage = ethers.utils.parseUnits('1.1')
    const revertMaxAuctionSlippage = ethers.utils.parseUnits('1')
    const newTwapPeriod = 300 // 5 minutes
    const newDeltaHedgeThreshold = ethers.utils.parseUnits('0.01')
    const revertDeltaHedgeThreshold = ethers.utils.parseUnits('0.3')


    it('should revert if non owner tries to change the hedge time threshold', async () => {
      await expect(crabStrategy.connect(random).setHedgeTimeThreshold(newHedgeTimeTolerance)).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it('should revert if owner tries to change the hedge time threshold to 0', async () => {
      await expect(crabStrategy.connect(owner).setHedgeTimeThreshold(0)).to.be.revertedWith("C7")
    })

    it('should allow owner to change the hedge time threshold', async () => {
      await crabStrategy.connect(owner).setHedgeTimeThreshold(newHedgeTimeTolerance)
      const hedgeTimeThresholdInContract = await crabStrategy.hedgeTimeThreshold()
      expect(hedgeTimeThresholdInContract.eq(newHedgeTimeTolerance)).to.be.true
    })

    it('should allow owner to change the hedge time threshold back', async () => {
      await crabStrategy.connect(owner).setHedgeTimeThreshold(hedgeTimeTolerance)
      const hedgeTimeThresholdInContract = await crabStrategy.hedgeTimeThreshold()
      expect(hedgeTimeThresholdInContract.eq(hedgeTimeTolerance)).to.be.true
    })

    it('should revert if non owner tries to change the hedge price threshold', async () => {
      await expect(crabStrategy.connect(random).setHedgePriceThreshold(newHedgePriceTolerance)).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it('should revert if owner tries to change the hedge price threshold to 0', async () => {
      await expect(crabStrategy.connect(owner).setHedgePriceThreshold(0)).to.be.revertedWith("C8")
    })

    it('should revert if owner tries to change the hedge price threshold to 1e18+1', async () => {
      await expect(crabStrategy.connect(owner).setHedgePriceThreshold(one.add(1))).to.be.revertedWith("C8")
    })

    it('should allow owner to change the hedge price threshold', async () => {
      await crabStrategy.connect(owner).setHedgePriceThreshold(newHedgePriceTolerance)
      const hedgePriceThresholdInContract = await crabStrategy.hedgePriceThreshold()
      expect(hedgePriceThresholdInContract.eq(newHedgePriceTolerance)).to.be.true
    })

    it('should allow owner to change the hedge price threshold back', async () => {
      await crabStrategy.connect(owner).setHedgePriceThreshold(hedgePriceTolerance)
      const hedgePriceThresholdInContract = await crabStrategy.hedgePriceThreshold()
      expect(hedgePriceThresholdInContract.eq(hedgePriceTolerance)).to.be.true
    })

    it('should revert if non owner tries to change the delta hedge threshold', async () => {
      await expect(crabStrategy.connect(random).setHedgingTwapPeriod(newTwapPeriod)).to.be.revertedWith("Ownable: caller is not the owner")
    })


    it('should revert if owner tries to change the twap period to too short of a value', async () => {
      await expect(crabStrategy.connect(owner).setHedgingTwapPeriod(179)).to.be.revertedWith("C14")
    })

    it('should allow owner to change the twap period and then change it back', async () => {

      const twapPeriodBefore = await crabStrategy.hedgingTwapPeriod()
      await crabStrategy.connect(owner).setHedgingTwapPeriod(newTwapPeriod)
      const newTwapPeriodInContract = await crabStrategy.hedgingTwapPeriod()
      expect(newTwapPeriodInContract === newTwapPeriod).to.be.true
      await crabStrategy.connect(owner).setHedgingTwapPeriod(twapPeriodBefore)
      const newTwapPeriodInContractRevert = await crabStrategy.hedgingTwapPeriod()
      expect(newTwapPeriodInContractRevert === twapPeriodBefore).to.be.true
    })
  });

  describe("Deposit into strategy", async () => {
    const strategyCap = ethers.utils.parseUnits("100")
    const wSquFuryEthPrice = BigNumber.from('3030').mul(one).div(oracleScaleFactor)
    const ethUSDPrice = BigNumber.from('3000').mul(one)

    before(async () => {
      await oracle.connect(owner).setPrice(wSquFuryEthPool.address, wSquFuryEthPrice)
      await oracle.connect(random).setPrice(ethUSDPool.address, ethUSDPrice)  // usdc per 1 eth
    })

    it('should revert deposits if crab not yet initialized as the cap will be 0', async () => {
      await expect(crabStrategy.connect(depositor2).deposit({ value: 1 })).to.be.revertedWith("C16");
    })

    it("Should initialize strategy", async () => {
      const normFactor = BigNumber.from(1)
      const ethToDeposit = BigNumber.from(60).mul(one)
      const squfuryDelta = wSquFuryEthPrice.mul(2);
  
      const feeAdj = 0;
      const debtToMint = ethToDeposit.mul(one).div(squfuryDelta.add(feeAdj));
      const expectedMintedWsqufury = debtToMint.mul(normFactor)

      await crabStrategy.connect(crabMigration).initialize( expectedMintedWsqufury, ethToDeposit, 0, 0, strategyCap, { value: ethToDeposit });

      const totalSupply = (await crabStrategy.totalSupply())
      const migrationCrabV2Balance = (await crabStrategy.balanceOf(crabMigration.address))
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const debtAmount = strategyVault.shortAmount
      const migrationSquFuryBalance = await squfury.balanceOf(crabMigration.address);
      const strategyContractSquFury = await squfury.balanceOf(crabStrategy.address)

      expect(totalSupply.eq(ethToDeposit)).to.be.true
      expect(migrationCrabV2Balance.eq(ethToDeposit)).to.be.true
      expect(isSimilar(debtAmount.toString(), debtToMint.toString(), 10)).to.be.true
      expect(isSimilar(migrationSquFuryBalance.toString(), expectedMintedWsqufury.toString(), 10)).to.be.true
      expect(strategyContractSquFury.eq(BigNumber.from(0))).to.be.true

      // Send the crab shares and squfury to the depositor
      await crabStrategy.connect(crabMigration).transfer(depositor.address, migrationCrabV2Balance);
      await squfury.connect(crabMigration).transfer(depositor.address, migrationSquFuryBalance);
    })

    it('should revert non owner tries to set the strategy cap', async () => {
      await expect(crabStrategy.connect(random).setStrategyCap(strategyCap)).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it('should allow owner to increase the strategy cap', async () => {
      await crabStrategy.connect(owner).setStrategyCap(strategyCap.mul(2))
      const strategyCapInContract = await crabStrategy.strategyCap()
      expect(strategyCapInContract.eq(strategyCap.mul(2))).to.be.true
    })

    it('should allow owner to reduce the strategy cap', async () => {
      await crabStrategy.connect(owner).setStrategyCap(strategyCap)
      const strategyCapInContract = await crabStrategy.strategyCap()
      expect(strategyCapInContract.eq(strategyCap)).to.be.true
    })
    it("Should not allow reinitialization of Crab v2", async () => { 
      await expect(crabStrategy.connect(crabMigration).initialize(0, 0, 0, 0, 0, {value: 0})).to.be.revertedWith("C11")
    })


    it("Should deposit and mint correct LP when initial debt != 0 and return the correct amount of wSquFury debt per crab strategy token", async () => {
      const normFactor = BigNumber.from(1)
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const strategyDebtBefore = strategyVault.shortAmount
      const strategyCollateralBefore = strategyVault.collateralAmount
      const totalCrabBefore = await crabStrategy.totalSupply()

      const ethToDeposit = BigNumber.from(20).mul(one)
      const depositorShare = wdiv(ethToDeposit, (strategyCollateralBefore.add(ethToDeposit)))
      const expectedDepositorCrab = wdiv(wmul(totalCrabBefore, depositorShare), (one.sub(depositorShare)))
      //   const squfuryDelta = wSquFuryEthPrice.mul(2);

      // const feeAdj = ethUSDPrice.mul(100).div(10000)
      const feeAdj = 0
      const debtToMint = ethToDeposit.mul(strategyDebtBefore).div(strategyCollateralBefore.add(strategyDebtBefore.mul(feeAdj).div(one)));
      const expectedMintedWsqufury = debtToMint.mul(normFactor)

      await crabStrategy.connect(depositor2).deposit({ value: ethToDeposit });

      const totalCrabAfter = (await crabStrategy.totalSupply())
      const depositorCrab = (await crabStrategy.balanceOf(depositor2.address))
      const strategyVaultAfter = await controller.vaults(await crabStrategy.vaultId());
      const debtAmount = strategyVaultAfter.shortAmount
      const depositorSquFuryBalance = await squfury.balanceOf(depositor2.address)
      const strategyContractSquFury = await squfury.balanceOf(crabStrategy.address)
      const depositorWSquFuryDebt = await crabStrategy.getWsqufuryFromCrabAmount(depositorCrab)

      expect(totalCrabAfter.eq(totalCrabBefore.add(expectedDepositorCrab))).to.be.true
      expect(depositorCrab.eq(expectedDepositorCrab)).to.be.true
      expect(isSimilar(strategyDebtBefore.add(debtToMint).toString(), debtAmount.toString(), 10)).to.be.true
      expect(isSimilar(depositorSquFuryBalance.toString(), expectedMintedWsqufury.toString(), 10)).to.be.true
      expect(strategyContractSquFury.eq(BigNumber.from(0))).to.be.true
      expect(depositorWSquFuryDebt.eq(depositorSquFuryBalance))
    })
    it('should revert if cap is hit', async () => {
      const strategyCap = await crabStrategy.strategyCap()
      const result = await crabStrategy.getVaultDetails()
      const ethToDeposit = strategyCap.sub(result[2]).add(1)

      await expect(crabStrategy.connect(depositor2).deposit({ value: ethToDeposit })).to.be.revertedWith("C16");
    })
  })

  describe("Withdraw from strategy", async () => {
    it("should revert withdrawing from a random account", async () => {
      const depositorSquFuryBalanceBefore = await squfury.balanceOf(depositor.address)
      const depositorCrabBefore = (await crabStrategy.balanceOf(depositor.address))
      const wSquFuryAmount = depositorSquFuryBalanceBefore

      await squfury.connect(random).approve(crabStrategy.address, depositorCrabBefore)

      await expect(
        crabStrategy.connect(random).withdraw(depositorCrabBefore)
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    })

    it("should withdraw 0 correctly", async () => {
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const strategyDebtBefore = strategyVault.shortAmount
      const strategyCollateralBefore = strategyVault.collateralAmount
      const totalCrabBefore = await crabStrategy.totalSupply()
      const depositorCrabBefore = (await crabStrategy.balanceOf(depositor.address))
      const depositorSquFuryBalanceBefore = await squfury.balanceOf(depositor.address)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)

      const expectedCrabPercentage = wdiv(depositorCrabBefore, totalCrabBefore)
      const expectedEthToWithdraw = wmul(strategyCollateralBefore, expectedCrabPercentage)

      await squfury.connect(depositor).approve(crabStrategy.address, 0)
      await crabStrategy.connect(depositor).withdraw(0);

      const strategyVaultAfter = await controller.vaults(await crabStrategy.vaultId());
      const strategyCollateralAfter = strategyVaultAfter.collateralAmount
      const strategyDebtAfter = strategyVaultAfter.shortAmount
      const totalCrabAfter = await crabStrategy.totalSupply()
      const depositorCrabAfter = (await crabStrategy.balanceOf(depositor.address))
      const depositorSquFuryBalanceAfter = await squfury.balanceOf(depositor.address)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)

      expect(depositorSquFuryBalanceAfter.eq(depositorSquFuryBalanceBefore)).to.be.true
      expect(depositorCrabAfter.eq(depositorCrabBefore)).to.be.true
      expect(totalCrabAfter.eq(totalCrabBefore)).to.be.true
      expect(strategyCollateralAfter.eq(strategyCollateralBefore)).to.be.true
      expect(strategyDebtAfter.eq(strategyDebtBefore)).to.be.true
      expect(isSimilar(depositorEthBalanceAfter.toString(), depositorEthBalanceBefore.toString())).to.be.true
    })

    it("should withdraw correct amount", async () => {
      const strategyVault = await controller.vaults(await crabStrategy.vaultId());
      const strategyDebtBefore = strategyVault.shortAmount
      const strategyCollateralBefore = strategyVault.collateralAmount
      const totalCrabBefore = await crabStrategy.totalSupply()
      const depositorCrabBefore = (await crabStrategy.balanceOf(depositor.address))
      const depositorSquFuryBalanceBefore = await squfury.balanceOf(depositor.address)
      const depositorEthBalanceBefore = await provider.getBalance(depositor.address)

      const expectedCrabPercentage = wdiv(depositorCrabBefore, totalCrabBefore)
      const expectedEthToWithdraw = wmul(strategyCollateralBefore, expectedCrabPercentage)

      await squfury.connect(depositor).approve(crabStrategy.address, depositorSquFuryBalanceBefore)
      await crabStrategy.connect(depositor).withdraw(depositorCrabBefore);

      const strategyVaultAfter = await controller.vaults(await crabStrategy.vaultId());
      const strategyCollateralAfter = strategyVaultAfter.collateralAmount
      const strategyDebtAfter = strategyVaultAfter.shortAmount
      const totalCrabAfter = await crabStrategy.totalSupply()
      const depositorCrabAfter = (await crabStrategy.balanceOf(depositor.address))
      const depositorSquFuryBalanceAfter = await squfury.balanceOf(depositor.address)
      const depositorEthBalanceAfter = await provider.getBalance(depositor.address)

      expect(depositorSquFuryBalanceAfter.eq(BigNumber.from(0))).to.be.true
      expect(depositorSquFuryBalanceBefore.gt(BigNumber.from(0))).to.be.true
      expect(depositorCrabAfter.eq(BigNumber.from(0))).to.be.true
      expect(totalCrabAfter.eq(totalCrabBefore.sub(depositorCrabBefore))).to.be.true
      expect(strategyCollateralAfter.eq(strategyCollateralBefore.sub(expectedEthToWithdraw))).to.be.true
      expect(strategyDebtAfter.eq(strategyDebtBefore.sub(depositorSquFuryBalanceBefore))).to.be.true
      expect(isSimilar(depositorEthBalanceAfter.sub(depositorEthBalanceBefore).toString(), expectedEthToWithdraw.toString())).to.be.true
    })
  })

  describe("Migrate vault to new strategy", async () => {
    const strategyCap = ethers.utils.parseUnits("100")
    const ethToDeposit = BigNumber.from(60).mul(one)

    it("Should revert if non owner tries to migrate", async () => {
      await expect(crabStrategy.connect(random).transferVault(depositor.address)).to.be.revertedWith("C1")
    })

    it("Should revert if owner tries to migrate directly", async () => {
      await expect(crabStrategy.connect(owner).transferVault(depositor.address)).to.be.revertedWith("C1")
    })

    it("Should migrate and disable deposit/withdraw if transfer is called by timelock", async () => {
      await crabStrategy.connect(owner).setStrategyCap(strategyCap)
      await crabStrategy.connect(depositor).deposit({ value: ethToDeposit })
      const depositorCrabBefore = (await crabStrategy.balanceOf(depositor.address))
      const depositorSquFuryBalanceBefore = await squfury.balanceOf(depositor.address)

      // Transfer here
      await timelock.connect(owner).executeVaultTransfer(crabStrategy.address, random.address)
      const nftBalAfter = await shortSquFury.balanceOf(crabStrategy.address)
      const nftBalForRandom = await shortSquFury.balanceOf(random.address)

      const newCap = await crabStrategy.strategyCap()
      expect(nftBalAfter.eq(0)).to.be.true
      expect(nftBalForRandom.eq(1)).to.be.true
      expect(newCap.eq(0)).to.be.true

      // Try to withdraw
      await squfury.connect(depositor).approve(crabStrategy.address, depositorSquFuryBalanceBefore)
      await expect(crabStrategy.connect(depositor).withdraw(depositorCrabBefore)).to.be.revertedWith('C3')

      // Try to deposit
      await expect(crabStrategy.connect(depositor).deposit({ value: ethToDeposit })).to.be.revertedWith('C16')
    })
  })
})
