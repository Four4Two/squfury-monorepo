import { task, types } from "hardhat/config";
import "@nomiclabs/hardhat-waffle";
import { getUniswapDeployments, getWETH } from "./utils";

/**
 npx hardhat increase-slots --network mainnet --slots 128
 */
task("increase-slots", "Increase Pool slot")
  .addParam('slots', 'how many slots to increase', 256, types.int)
  .setAction(async ({slots}, hre) => {

  const { getNamedAccounts, ethers, network } = hre;
  
  const { deployer } = await getNamedAccounts();
  const { uniswapFactory } = await getUniswapDeployments(ethers, deployer, network.name)

  const wsqufury = await ethers.getContractAt("WPowerPerp", deployer);
  const weth = await getWETH(ethers, deployer, network.name)

  const isWethToken0 = parseInt(weth.address, 16) < parseInt(wsqufury.address, 16)
  const token0 = isWethToken0 ? weth.address : wsqufury.address
  const token1 = isWethToken0 ? wsqufury.address : weth.address
  
  const poolAddr = await uniswapFactory.getPool(token0, token1, 3000)
  const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
  console.log(`SquFury Pool Address: ${pool.address.toString()}`)
  
  const { observationCardinalityNext } =  await pool.slot0()
  console.log(`Current observationCardinalityNext ${observationCardinalityNext.toString()}, adding ${slots} more`)

  const tx = await pool.increaseObservationCardinalityNext(observationCardinalityNext + slots)
  console.log(`Transaction Hash: ${tx.hash}, tx.nonce ${tx.nonce}`)

});
