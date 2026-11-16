// Deploys a fresh MockChainlink and points the existing InterestRateModel at it.
// Used to swap out the original Sepolia oracle, whose setters were unguarded.
const { ethers, network } = require("hardhat")
const fs = require("fs")
const path = require("path")

async function main() {
	const file = path.join(__dirname, "..", "deployments", `${network.name}.json`)
	const d = JSON.parse(fs.readFileSync(file))
	const irm = await ethers.getContractAt("InterestRateModel", d.InterestRateModel)

	const [me] = await ethers.getSigners()
	// Explicit nonces: load-balanced RPCs can report a stale pending count between txs.
	const nonce = await me.getTransactionCount("pending")
	const oracle = await (await ethers.getContractFactory("MockChainlink")).deploy({ nonce })
	await oracle.deployed()
	await (await irm.setAutomatedFunctionsConsumer(oracle.address, { nonce: nonce + 1 })).wait()

	if ((await irm.automatedFunctionsConsumer()) !== oracle.address)
		throw new Error("repoint failed")
	console.log(`MockChainlink ${d.MockChainlink} -> ${oracle.address}`)
	d.MockChainlink = oracle.address
	fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n")
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e)
		process.exit(1)
	})
