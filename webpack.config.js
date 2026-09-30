const path = require("path");

/** @type {import("webpack").Configuration} */
const common = {
  mode: "production",
  resolve: { extensions: [".ts", ".js"] },
  module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: "ts-loader" }] },
  devtool: "source-map",
  optimization: { minimize: true }
};

module.exports = [{
  ...common,
  target: "node",
  entry: "./src/extension.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
    devtoolModuleFilenameTemplate: "../[resource-path]"
  },
  externals: { vscode: "commonjs vscode" },
}, {
  ...common,
  target: "web",
  entry: { chat: "./src/webview/chat.ts", sidebar: "./src/webview/sidebar.ts", settings: "./src/webview/settings.ts" },
  output: { path: path.resolve(__dirname, "dist"), filename: "[name].js" }
}];
