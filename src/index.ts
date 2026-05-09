import Addon from './addon';
import { BasicTool } from 'zotero-plugin-toolkit';
import { config } from '../package.json';

const basicTool = new BasicTool();

if (!basicTool.getGlobal('Zotero')[config.addonInstance]) {
    // @ts-expect-error - Plugin instance dynamic injection
    _globalThis.addon = new Addon();
    function defineGlobal(name: string, getter?: () => any) {
        Object.defineProperty(_globalThis, name, {
            get() {
                return getter ? getter() : basicTool.getGlobal(name);
            },
        });
    }
    defineGlobal('ztoolkit', () => _globalThis.addon.data.ztoolkit);
    // @ts-expect-error
    Zotero[config.addonInstance] = addon;
}
