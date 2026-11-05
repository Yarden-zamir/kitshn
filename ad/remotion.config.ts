import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// three.js needs a real WebGL context in headless Chrome.
Config.setChromiumOpenGlRenderer("angle");
