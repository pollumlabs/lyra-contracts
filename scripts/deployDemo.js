// Deploys the full Lyra demo stack on any EVM chain without Chainlink Functions:
// MockChainlink stands in for the SELIC oracle, and a local Uniswap v3 pool
// backs recall/liquidation. Writes addresses to deployments/<network>.json.
const { ethers, network } = require("hardhat")
const bn = require("bignumber.js")
const fs = require("fs")
const path = require("path")
const { Pool, Position, nearestUsableTick } = require("@uniswap/v3-sdk")
const { Token } = require("@uniswap/sdk-core")

bn.config({ EXPONENTIAL_AT: 999999, DECIMAL_PLACES: 40 })

const uni = {
	Factory: require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"),
	Pool: require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json"),
	SwapRouter: require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json"),
	NFTDescriptor: require("@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json"),
	PositionDescriptor: require("@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json"),
	PositionManager: require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
}

// 1 TSELIC29 (18 dec) ≈ 13,991 DREX (6 dec), matching MockChainlink's unit value.
const DREX_PER_TSELIC_RAW = "13991000000"
const ONE_TSELIC_RAW = "1000000000000000000"
const FEE = 3000

const FAUCET_TSELIC = ethers.utils.parseUnits("100000", 18)
const FAUCET_DREX = ethers.utils.parseUnits("500000000", 6)
const SEED_POOL_DREX = ethers.utils.parseUnits("1000000", 6)

const outFile = path.join(__dirname, "..", "deployments", `${network.name}.json`)
// Resume a partial run: contracts already recorded in the file are reused, not redeployed.
const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile)) : {}
const saveOut = () => {
	fs.mkdirSync(path.dirname(outFile), { recursive: true })
	fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n")
}
async function deploy(name, factory, ...args) {
	if (out[name]) {
		console.log(`${name.padEnd(20)} ${out[name]} (existing)`)
		return factory.attach(out[name])
	}
	const c = await factory.deploy(...args)
	await c.deployed()
	out[name] = c.address
	saveOut()
	console.log(`${name.padEnd(20)} ${c.address}`)
	return c
}
const send = async (txPromise) => (await txPromise).wait()
out.done = out.done || []
// Non-deploy side effects (mints, transfers) run once; reruns skip what's recorded.
async function step(name, fn) {
	if (out.done.includes(name)) return console.log(`step ${name} (done)`)
	await fn()
	out.done.push(name)
	saveOut()
	console.log(`step ${name}`)
}

// Load-balanced public RPCs can return a stale pending nonce right after a tx,
// so assign nonces locally instead of asking the node each time.
async function pinNonces(address) {
	let next = 0
	for (let i = 0; i < 3; i++)
		next = Math.max(next, await ethers.provider.getTransactionCount(address, "pending"))
	const inject = (method, params) => {
		if (
			method === "eth_sendTransaction" &&
			params[0].from.toLowerCase() === address.toLowerCase()
		)
			params[0].nonce = "0x" + next.toString(16)
	}
	const p = network.provider
	const origRequest = p.request.bind(p)
	const origSend = p.send.bind(p)
	p.request = async (args) => {
		inject(args.method, args.params || [])
		const r = await origRequest(args)
		if (args.method === "eth_sendTransaction") next++
		return r
	}
	p.send = async (method, params = []) => {
		inject(method, params)
		const r = await origSend(method, params)
		if (method === "eth_sendTransaction") next++
		return r
	}
}

function encodePriceSqrt(reserve1, reserve0) {
	return ethers.BigNumber.from(
		new bn(reserve1)
			.div(reserve0)
			.sqrt()
			.multipliedBy(new bn(2).pow(96))
			.integerValue(3)
			.toString()
	)
}

function linkNFTDescriptor(bytecode, libAddress) {
	// NonfungibleTokenPositionDescriptor links NFTDescriptor at byte offset 1681.
	const start = 2 + 1681 * 2
	return bytecode.slice(0, start) + libAddress.toLowerCase().slice(2) + bytecode.slice(start + 40)
}

async function deployUniswap(deployer, tselic, drex) {
	const weth = await deploy("WETH9", await ethers.getContractFactory("WETH9"))
	const f = (a) => new ethers.ContractFactory(a.abi, a.bytecode, deployer)
	const factory = await deploy("UniswapV3Factory", f(uni.Factory))
	const router = await deploy("SwapRouter", f(uni.SwapRouter), factory.address, weth.address)
	const nftDescriptor = await deploy("NFTDescriptor", f(uni.NFTDescriptor))
	const posDescriptor = await deploy(
		"PositionDescriptor",
		new ethers.ContractFactory(
			uni.PositionDescriptor.abi,
			linkNFTDescriptor(uni.PositionDescriptor.bytecode, nftDescriptor.address),
			deployer
		),
		weth.address,
		ethers.utils.formatBytes32String("WETH")
	)
	const npm = await deploy(
		"PositionManager",
		f(uni.PositionManager),
		factory.address,
		weth.address,
		posDescriptor.address
	)

	const tselicIsToken0 = tselic.address.toLowerCase() < drex.address.toLowerCase()
	const [token0, token1] = tselicIsToken0 ? [tselic, drex] : [drex, tselic]
	const sqrtPrice = tselicIsToken0
		? encodePriceSqrt(DREX_PER_TSELIC_RAW, ONE_TSELIC_RAW)
		: encodePriceSqrt(ONE_TSELIC_RAW, DREX_PER_TSELIC_RAW)

	await step("createUniPool", () =>
		send(npm.createAndInitializePoolIfNecessary(token0.address, token1.address, FEE, sqrtPrice))
	)
	const poolAddress = await factory.getPool(token0.address, token1.address, FEE)
	out.UniswapPool = poolAddress
	console.log(`${"UniswapPool".padEnd(20)} ${poolAddress}`)

	const pool = new ethers.Contract(poolAddress, uni.Pool.abi, ethers.provider)
	const [tickSpacing, slot0] = await Promise.all([pool.tickSpacing(), pool.slot0()])
	const { chainId } = await ethers.provider.getNetwork()
	const sdkPool = new Pool(
		new Token(chainId, tselic.address, 18, "TSELIC29"),
		new Token(chainId, drex.address, 6, "DREX"),
		FEE,
		slot0.sqrtPriceX96.toString(),
		"0",
		slot0.tick
	)
	const tickLower = nearestUsableTick(slot0.tick, tickSpacing) - tickSpacing * 2
	const tickUpper = nearestUsableTick(slot0.tick, tickSpacing) + tickSpacing * 2
	// SDK sorts tokens itself, so amount0/amount1 already line up with token0/token1.
	const { amount0, amount1 } = new Position({
		pool: sdkPool,
		liquidity: ethers.utils.parseEther("1").toString(),
		tickLower,
		tickUpper,
	}).mintAmounts

	await step("approveUni0", () => send(token0.approve(npm.address, ethers.constants.MaxUint256)))
	await step("approveUni1", () => send(token1.approve(npm.address, ethers.constants.MaxUint256)))
	await step("mintUniLiquidity", async () =>
		send(
			npm.mint({
				token0: token0.address,
				token1: token1.address,
				fee: FEE,
				tickLower,
				tickUpper,
				amount0Desired: amount0.toString(),
				amount1Desired: amount1.toString(),
				amount0Min: 0,
				amount1Min: 0,
				recipient: deployer.address,
				deadline: (await ethers.provider.getBlock("latest")).timestamp + 3600,
			})
		)
	)
	return router
}

async function main() {
	const [deployer] = await ethers.getSigners()
	const bal = await deployer.getBalance()
	console.log(
		`network ${network.name}, deployer ${deployer.address}, balance ${ethers.utils.formatEther(
			bal
		)}`
	)
	if (bal.isZero()) throw new Error("Deployer has no gas funds")
	if (network.name !== "hardhat") await pinNonces(deployer.address)

	const drex = await deploy("DREX", await ethers.getContractFactory("DREX"))
	const tselic = await deploy("TSELIC29", await ethers.getContractFactory("TSELIC29"))
	const oracle = await deploy("MockChainlink", await ethers.getContractFactory("MockChainlink"))
	const irm = await deploy(
		"InterestRateModel",
		await ethers.getContractFactory("InterestRateModel"),
		oracle.address
	)
	const pool = await deploy(
		"rBRLLPool",
		await ethers.getContractFactory("rBRLLPool"),
		deployer.address,
		tselic.address,
		drex.address
	)
	await step("grantPoolManager", async () =>
		send(pool.grantRole(await pool.POOL_MANAGER_ROLE(), deployer.address))
	)

	const router = await deployUniswap(deployer, tselic, drex)
	const liquidatePool = await deploy(
		"LiquidatePool",
		await ethers.getContractFactory("LiquidatePool"),
		deployer.address,
		pool.address,
		tselic.address,
		drex.address,
		router.address
	)

	await step("initLiquidatePool", () => send(pool.initLiquidatePool(liquidatePool.address)))
	await step("setInterestRateModel", () => send(pool.setInterestRateModel(irm.address)))
	await step("setFeeCollector", () => send(liquidatePool.setFeeCollector(deployer.address)))

	const faucet = await deploy(
		"DualTokenFaucet",
		await ethers.getContractFactory("DualTokenFaucet"),
		tselic.address,
		drex.address
	)
	await step("fundFaucetTSELIC", () => send(tselic.transfer(faucet.address, FAUCET_TSELIC)))
	await step("fundFaucetDREX", () => send(drex.transfer(faucet.address, FAUCET_DREX)))

	// Seed the lending pool so a fresh visitor can borrow immediately.
	await step("approveSeed", () => send(drex.approve(pool.address, SEED_POOL_DREX)))
	await step("seedPool", () => send(pool.supplyDREX(SEED_POOL_DREX)))

	out.chainId = (await ethers.provider.getNetwork()).chainId
	out.deployer = deployer.address
	saveOut()
	console.log(`\nwrote ${path.relative(process.cwd(), outFile)}`)
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e)
		process.exit(1)
	})
