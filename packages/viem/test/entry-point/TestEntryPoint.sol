// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// A stand-in for the ERC-4337 EntryPoint v0.7, for the user operation tests on Anvil. It has the v0.7 user operation
// hash, nonces and events, and runs each operation's call data on its sender. It does not validate signatures, charge
// gas or pay the beneficiary: the tests check what the adapter records, not the EntryPoint.

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

contract TestEntryPoint {
    event UserOperationEvent(
        bytes32 indexed userOpHash,
        address indexed sender,
        address indexed paymaster,
        uint256 nonce,
        bool success,
        uint256 actualGasCost,
        uint256 actualGasUsed
    );
    event UserOperationRevertReason(
        bytes32 indexed userOpHash,
        address indexed sender,
        uint256 nonce,
        bytes revertReason
    );

    mapping(address => mapping(uint192 => uint256)) public nonceSequenceNumber;

    function getNonce(address sender, uint192 key) public view returns (uint256) {
        return nonceSequenceNumber[sender][key] | (uint256(key) << 64);
    }

    function getUserOpHash(PackedUserOperation calldata op) public view returns (bytes32) {
        bytes32 packed = keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                op.preVerificationGas,
                op.gasFees,
                keccak256(op.paymasterAndData)
            )
        );
        return keccak256(abi.encode(packed, address(this), block.chainid));
    }

    function handleOps(PackedUserOperation[] calldata ops, address payable) external {
        for (uint256 i = 0; i < ops.length; i++) {
            uint256 gasStart = gasleft();
            PackedUserOperation calldata op = ops[i];
            bytes32 userOpHash = getUserOpHash(op);
            uint192 key = uint192(op.nonce >> 64);
            require(nonceSequenceNumber[op.sender][key]++ == uint64(op.nonce), "AA25 invalid account nonce");
            address paymaster = op.paymasterAndData.length >= 20 ? address(bytes20(op.paymasterAndData[:20])) : address(0);
            (bool success, bytes memory result) = op.sender.call(op.callData);
            if (!success) emit UserOperationRevertReason(userOpHash, op.sender, op.nonce, result);
            uint256 gasUsed = gasStart - gasleft() + op.preVerificationGas;
            emit UserOperationEvent(userOpHash, op.sender, paymaster, op.nonce, success, gasUsed * tx.gasprice, gasUsed);
        }
    }
}

// A smart account that runs the calls the EntryPoint passes it, and rethrows a failed call's revert data.
contract TestAccount {
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function execute(address target, uint256 value, bytes calldata data) external {
        require(msg.sender == ENTRY_POINT, "not the EntryPoint");
        call(target, value, data);
    }

    function executeBatch(Call[] calldata calls) external {
        require(msg.sender == ENTRY_POINT, "not the EntryPoint");
        for (uint256 i = 0; i < calls.length; i++) call(calls[i].target, calls[i].value, calls[i].data);
    }

    function call(address target, uint256 value, bytes calldata data) private {
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    receive() external payable {}
}

// Reverts every call with Error("boom").
contract Reverter {
    fallback() external payable {
        revert("boom");
    }
}
