// The Hardhat 3 project of hardhat.int.test.ts, with the plugins of Hardhat's viem template that the docs examples
// use, on Hardhat's in-process network. The artifacts of contracts/Counter.sol are committed and every run passes
// `--no-compile`, because a build downloads solc and the tests never reach a public network. After changing the
// contract, run `pnpm exec hardhat build` in this directory and commit artifacts/ (build-info/ is ignored).
import hardhatIgnitionViem from '@nomicfoundation/hardhat-ignition-viem';
import hardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner';
import hardhatViem from '@nomicfoundation/hardhat-viem';
import { defineConfig } from 'hardhat/config';

export default defineConfig({
  plugins: [hardhatViem, hardhatIgnitionViem, hardhatNodeTestRunner],
  solidity: '0.8.28',
});
