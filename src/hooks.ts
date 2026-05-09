import { config } from '../package.json';
import { initLocale } from './utils/locale';
import PatentModule from './modules/patent';

async function onStartup() {
    await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);

    initLocale();

    // Register menu if main window is already available
    const mainWindow = Zotero.getMainWindow();
    if (mainWindow && mainWindow.document.readyState === 'complete') {
        Zotero.debug('[Patent] Main window already loaded, registering menu now');
        PatentModule.registerMenu();
    } else {
        // Wait for main window to load
        const checkWindow = () => {
            const win = Zotero.getMainWindow();
            if (win && win.document.readyState === 'complete') {
                Zotero.debug('[Patent] Main window loaded, registering menu');
                PatentModule.registerMenu();
            } else {
                setTimeout(checkWindow, 100);
            }
        };
        setTimeout(checkWindow, 100);
    }

    addon.data.initialized = true;
}

async function onMainWindowLoad(win: Window): Promise<void> {
    Zotero.debug('[Patent] onMainWindowLoad called');
    PatentModule.registerMenu();
}

function onMainWindowUnload(win: Window) {
    Zotero.debug('[Patent] onMainWindowUnload called');
    PatentModule.unregisterMenu?.();
}

function onShutdown() {
    ztoolkit.unregisterAll();
    PatentModule.unregisterMenu?.();
    addon.data.alive = false;
    delete Zotero[config.addonInstance];
}

export default {
    onStartup,
    onShutdown,
    onMainWindowLoad,
    onMainWindowUnload,
};
