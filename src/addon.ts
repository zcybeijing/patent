import hooks from './hooks';
import { createZToolkit } from './utils/ztoolkit';

export default class Addon {
    data: { [k: string]: any };

    constructor() {
        this.data = {
            config: require('../package.json').config,
            initialized: false,
            alive: true,
            ztoolkit: createZToolkit(),
        };
    }

    hooks = hooks;
}
