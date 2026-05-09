/**
 * Most of this code is from Zotero team's official Make It Red example[1]
 * or the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
    Zotero.debug('[Patent] ========== bootstrap startup STARTED, reason=' + reason + ' ==========');
    try {
        var aomStartup = Components.classes['@mozilla.org/addons/addon-manager-startup;1'].getService(
            Components.interfaces.amIAddonManagerStartup,
        );
        var manifestURI = Services.io.newURI(rootURI + 'manifest.json');
        chromeHandle = aomStartup.registerChrome(manifestURI, [
            ['content', '__addonRef__', rootURI + 'content/'],
            ['locale', '__addonRef__', 'en-US', rootURI + 'locale/en-US/'],
            ['locale', '__addonRef__', 'zh-CN', rootURI + 'locale/zh-CN/'],
        ]);
        Zotero.debug('[Patent] Chrome registered');

        const ctx = { rootURI };
        ctx._globalThis = ctx;

        Zotero.debug('[Patent] Loading subScript: ' + rootURI + 'content/scripts/__addonRef__.js');
        Services.scriptloader.loadSubScript(`${rootURI}/content/scripts/__addonRef__.js`, ctx);
        Zotero.debug('[Patent] subScript loaded successfully');
        Zotero.debug('[Patent] Zotero.ZoteroPatent exists: ' + !!Zotero.ZoteroPatent);

        if (Zotero.ZoteroPatent) {
            Zotero.debug('[Patent] Calling onStartup...');
            Zotero.ZoteroPatent.hooks.onStartup();
            Zotero.debug('[Patent] onStartup called (not awaited)');
        } else {
            Zotero.debug('[Patent] ERROR: Zotero.ZoteroPatent is undefined!');
        }
    } catch (e) {
        Zotero.debug('[Patent] ERROR in startup: ' + e + '\n' + e.stack);
    }
    Zotero.debug('[Patent] ========== bootstrap startup COMPLETED ==========');
}

async function onMainWindowLoad({ window }, reason) {
    Zotero.debug('[Patent] onMainWindowLoad called');
    await Zotero.ZoteroPatent?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
    Zotero.debug('[Patent] onMainWindowUnload called');
    await Zotero.ZoteroPatent?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
    Zotero.debug('[Patent] shutdown called, reason=' + reason);
    if (reason === APP_SHUTDOWN) {
        return;
    }

    await Zotero.ZoteroPatent?.hooks.onShutdown();

    if (chromeHandle) {
        chromeHandle.destruct();
        chromeHandle = null;
    }
}

async function uninstall(data, reason) {}
