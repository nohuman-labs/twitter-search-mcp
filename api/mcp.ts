import config from "../.generated/config.js";
import { createVercelHandler } from "../src/runtimes/vercel.js";

export default createVercelHandler({ config });
