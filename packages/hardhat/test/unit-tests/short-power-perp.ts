import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { ethers } from "hardhat"
import { expect } from "chai";
import { constants } from "ethers";
import { ShortPowerPerp, ControllerAccessTester} from "../../typechain";

describe("ShortPowerPerp", function () {
  let shortSquFury: ShortPowerPerp;
  let random: SignerWithAddress
  let controller: ControllerAccessTester
  let address1: SignerWithAddress

  this.beforeAll("Prepare accounts", async() => {
    const accounts = await ethers.getSigners();
    const [_address1, _random] = accounts;
    address1 = _address1
    random = _random
  });

  describe("Deployment", async () => {
    it("Deployment", async function () {
      const ShortPowerPerpContract = await ethers.getContractFactory("ShortPowerPerp");
      shortSquFury = (await ShortPowerPerpContract.deploy('Short SquFury', 'sSQU')) as ShortPowerPerp;
      const ControllerContract = await ethers.getContractFactory("ControllerAccessTester");
      controller = (await ControllerContract.deploy(shortSquFury.address)) as ControllerAccessTester;
    });
  });

  describe("Initialization", async () => {
    it("should revert when calling init with invalid address as controller", async () => {
      await expect(shortSquFury.init(constants.AddressZero)).to.be.revertedWith('Invalid controller address')
    })
    it("should revert when calling init from a random address", async() => {
      await expect(shortSquFury.connect(random).init(controller.address)).to.be.revertedWith("Invalid caller of init")
    })
    it("Should be able to init contract when called by the deployer", async () => {
      await shortSquFury.connect(address1).init(controller.address);
      const controllerAddress = await shortSquFury.controller();
      expect(controllerAddress).to.be.eq(controller.address,"Controller address mismatch");
    })
    it("should revert when trying to init again", async () => {
      await expect(shortSquFury.connect(address1).init(controller.address)).to.be.revertedWith("Initializable: contract is already initialized")
    })
  });

  describe("Access control", async () => {
    it("Should revert if mint called by an address other than controller ", async () => {
        await expect(shortSquFury.connect(random).mintNFT(address1.address)).to.be.revertedWith("Not controller")
    });
    it('Should mint nft with expected id if mint is called by controller', async() => {
      const expectedId = await shortSquFury.nextId()
      await controller.connect(address1).mintTest(random.address)
      expect(await shortSquFury.ownerOf(expectedId) === random.address).to.be.true
    })
  });

});
