// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MockChainlink {
	address public immutable owner;
	uint256 public selicRate;
	uint256 public unitValue;
	uint256 public maturityTime;

	modifier onlyOwner() {
		require(msg.sender == owner, "!owner");
		_;
	}

	constructor() {
		owner = msg.sender;
		selicRate = 12250000;
		unitValue = 14000000000000000000000;
		maturityTime = 1867014000;
	}

	function setSelicRate(uint256 _selicRate) public onlyOwner {
		selicRate = _selicRate;
	}

	function setUnitValue(uint256 _unitValue) public onlyOwner {
		unitValue = _unitValue;
	}

	function setMaturityTime(uint256 _maturityTime) public onlyOwner {
		maturityTime = _maturityTime;
	}
}
