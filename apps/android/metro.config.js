// Lets this app use the shared code in ../../packages, while React and
// React Native always come from THIS app's node_modules (not the web app's).
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const packages = path.resolve(projectRoot, '../../packages');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [packages];
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')];
config.resolver.extraNodeModules = {
  '@wealthfire/core': path.join(packages, 'core'),
  '@wealthfire/mobile-ui': path.join(packages, 'mobile-ui'),
};
// Never pick up node_modules from the repo root or from packages/*.
config.resolver.blockList = [
  new RegExp(`${path.resolve(projectRoot, '../../node_modules').replace(/[\\/]/g, '[\\\\/]')}[\\\\/].*`),
  new RegExp(`${packages.replace(/[\\/]/g, '[\\\\/]')}[\\\\/][^\\\\/]+[\\\\/]node_modules[\\\\/].*`),
];

module.exports = config;
