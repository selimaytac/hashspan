// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// The counter of Hardhat's viem project template, which the Hardhat tests of integrations/ deploy.
contract Counter {
  uint public x;

  event Increment(uint by);

  function inc() public {
    x++;
    emit Increment(1);
  }

  function incBy(uint by) public {
    require(by > 0, "incBy: increment should be positive");
    x += by;
    emit Increment(by);
  }
}
