import { task, types } from "hardhat/config";
import "@nomiclabs/hardhat-waffle";
import { getWETH, getUniswapDeployments } from './utils'

const tickSpace = 60

const estimated2xTickDelta = 6960 // 1.0001 ^ 6960 ~= 2. this number need to be dividable by 60

// eslint-disable-next-line
const estimated1_5xTickDelta = 4020 // 1.0001 ^ 4020 ~= 1.5 this number need to be dividable by 60

// Example execution
/**
  npx hardhat addSquFuryLiquidity --network ropsten --wsqufury-amount 0.0004 --collateral-amount 2 --base-price 3300 --range 2x
 */
task("addSquFuryLiquidity", "Add liquidity to wsqufury pool")
  .addParam('wsqufuryAmount', 'amount of wsqufury minting to add liquidity', '10', types.string)
  .addParam('collateralAmount', 'amount used as collateral to mint squfury', '6', types.string)
  .addParam('basePrice', 'estimated wsqufury/weth price', '0.3', types.string)
  .addParam('range', 'either full, 1.5x or 2x', '1.5x', types.string)
  .setAction(async ({
    wsqufuryAmount,
    collateralAmount,
    basePrice,
    range
  }, hre) => {

  const { getNamedAccounts, ethers, network } = hre;
  
  const { deployer } = await getNamedAccounts();
  const { positionManager, uniswapFactory } = await getUniswapDeployments(ethers, deployer, network.name)

  const controller = await ethers.getContract("Controller", deployer);
  const wsqufury = await ethers.getContract("WPowerPerp", deployer);
  const weth = await getWETH(ethers, deployer, network.name)

  const isWethToken0 = parseInt(weth.address, 16) < parseInt(wsqufury.address, 16)
  const token0 = isWethToken0 ? weth.address : wsqufury.address
  const token1 = isWethToken0 ? wsqufury.address : weth.address

  const poolAddr = await uniswapFactory.getPool(token0, token1, 3000)
  console.log(`Adding liquidity to squfury pool: ${poolAddr}`)

  const poolContract = await ethers.getContractAt("IUniswapV3Pool", poolAddr)
  const {tick} = await poolContract.slot0()

  const squfuryPriceInETH = parseFloat(basePrice)

  console.log(`estimated SquFury Price in ETH: ${squfuryPriceInETH}`)
  
  const liquidityWsqufuryAmount = ethers.utils.parseEther(wsqufuryAmount) 
  const wethAmount = parseFloat(wsqufuryAmount) * squfuryPriceInETH
  const liquidityWethAmount = ethers.utils.parseEther(wethAmount.toString()) 
  
  let wsqufuryBalance = await wsqufury.balanceOf(deployer)
  let wethBalance = await weth.balanceOf(deployer)

  if (wethBalance.lt(liquidityWethAmount)) {
    const tx = await weth.deposit({value: liquidityWethAmount, from: deployer})
    await ethers.provider.waitForTransaction(tx.hash, 1)
    wethBalance = await weth.balanceOf(deployer)
  }

  if (wsqufuryBalance.lt(liquidityWsqufuryAmount)) {
    console.log(`Minting ${wsqufuryAmount} rSquFury amount of wsqufury with ${collateralAmount} ETH`)
    const tx = await controller.mintWPowerPerpAmount(0, liquidityWsqufuryAmount, 0, {value: ethers.utils.parseEther(collateralAmount)}) 
    await ethers.provider.waitForTransaction(tx.hash, 1)
    wsqufuryBalance = await wsqufury.balanceOf(deployer)
  }

  // approve weth and wsqufury to be used by position manager
  const wethAllowance = await weth.allowance(deployer, positionManager.address)
  if (wethAllowance.lt(liquidityWethAmount)) {
    console.log(`Approving weth...`)
    const tx = await weth.approve(positionManager.address, ethers.constants.MaxUint256)
    await ethers.provider.waitForTransaction(tx.hash, 1)
  }

  const wsqufuryAllowance = await wsqufury.allowance(deployer, positionManager.address)
  if (wsqufuryAllowance.lt(liquidityWsqufuryAmount)) {
    console.log(`Approving wsqufury...`)
    const tx = await wsqufury.approve(positionManager.address, ethers.constants.MaxUint256)
    await ethers.provider.waitForTransaction(tx.hash, 1)
  }

  let tickLower = 0
  let tickUpper = 0
  if (range === 'full') {
    tickLower = -887220
    tickUpper = 887220
  } else {
    let tickDelta = 0
    if (range === '2x') {
      tickDelta = estimated2xTickDelta
      console.log(`using tick delta for 2x: ${tickDelta}`)
    } else {
      // eslint-disable-next-line
      tickDelta = estimated1_5xTickDelta
      console.log(`using tick delta for 1.5x: ${tickDelta}`)
    }
    const midTick = Math.floor(tick / tickSpace) * tickSpace
    tickUpper = midTick + tickDelta
    tickLower = midTick - tickDelta
    console.log(`Using tick range: ${tickLower} - ${tickUpper}`)
  }

  const mintParam = {
    token0,
    token1,
    fee: 3000,
    tickLower,
    tickUpper,
    amount0Desired: isWethToken0 ? liquidityWethAmount : liquidityWsqufuryAmount,
    amount1Desired: isWethToken0 ? liquidityWsqufuryAmount : liquidityWethAmount,
    amount0Min: 0,
    amount1Min: 0,
    recipient: deployer,// address
    deadline: Math.floor(Date.now() / 1000 + 86400),// uint256
  }

  const tx = await positionManager.mint(mintParam)
  console.log(`mint tx ${tx.hash}`)

});

