import { __ } from 'embark-i18n';
import { dappPath, toForwardSlashes, normalizePath } from 'embark-utils';
let chokidar = require('chokidar');
let path = require('path');

const DAPP_PIPELINE_CONFIG_FILE = 'pipeline.js';
const DAPP_WEBPACK_CONFIG_FILE = 'webpack.config.js';
const DAPP_BABEL_LOADER_OVERRIDES_CONFIG_FILE = 'babel-loader-overrides.js';

// TODO: this should be receiving the config object not re-reading the
// embark.json file

// TODO: rename file events to comply with naming convention

class Watcher {
  constructor(embark) {
    this.logger = embark.logger;
    this.events = embark.events;
    this.fs = embark.fs;
    this.fileWatchers = [];

    this.events.setCommandHandler('watcher:start', () => this.start());
    this.events.setCommandHandler('watcher:stop', () => this.stop());
    this.events.setCommandHandler('watcher:restart', () => this.restart());
  }

  // TODO: it needs to be more agnostic, the files to watch should be registered through the plugin api
  start() {
    let self = this;
    // TODO: should come from the config object instead of reading the file
    // directly
    let embarkConfig = this.fs.readJSONSync("embark.json");

    this.watchAssets(embarkConfig, function () {
      self.logger.trace('ready to watch asset changes');
    });

    this.watchContracts(embarkConfig, function () {
      self.logger.trace('ready to watch contract changes');
    });

    this.watchContractConfig(embarkConfig, function () {
      self.logger.trace('ready to watch contract config changes');
    });

    this.watchPipelineConfig(embarkConfig, function () {
      self.logger.trace('ready to watch pipeline config changes');
    });

    this.watchWebserverConfig(embarkConfig, function () {
      self.logger.trace('ready to watch webserver config changes');
    });

    this.logger.info(__("ready to watch file changes"));
  }

  restart() {
    this.stop();
    this.start();
  }

  stop() {
    this.fileWatchers.forEach(fileWatcher => {
      if (fileWatcher.shouldClose) return;
      if (fileWatcher.isReady) fileWatcher.close();
      fileWatcher.shouldClose = true;
    });
  }

  watchAssets(embarkConfig, callback) {
    let self = this;
    let appConfig = embarkConfig.app;
    let filesToWatch = [];

    for (let targetFile in appConfig) {
      let files = appConfig[targetFile];
      let fileGlob = files;

      // workaround for imports issue
      // so embark reacts to changes made in imported js files
      // chokidar glob patterns only work with front-slashes
      if (!Array.isArray(files)) {
        fileGlob = toForwardSlashes(path.join(path.dirname(files), '**', '*.*'));
      } else if (files.length === 1) {
        fileGlob = toForwardSlashes(path.join(path.dirname(files[0]), '**', '*.*'));
      }

      filesToWatch.push(fileGlob);
    }
    filesToWatch = Array.from(new Set(filesToWatch));

    this.watchFiles(
      filesToWatch,
      function (eventName, path) {
        self.logger.info(`${eventName}: ${path}`);
        self.events.emit('file-' + eventName, 'asset', path);
        self.events.emit('file-event', {fileType: 'asset', path});
      },
      function () {
        callback();
      }
    );
  }

  watchContracts(embarkConfig, callback) {
    let self = this;
    this.watchFiles(
      [embarkConfig.contracts],
      function (eventName, path) {
        self.logger.info(`${eventName}: ${path}`);
        self.events.emit('file-' + eventName, 'contract', path);
        self.events.emit('file-event', {fileType: 'contract', path});
      },
      function () {
        callback();
      }
    );
  }

  watchWebserverConfig(embarkConfig, callback) {
    let self = this;
    let webserverConfig;
    if (typeof embarkConfig.config === 'object') {
      if (!embarkConfig.config.webserver) {
        return;
      }
      webserverConfig = embarkConfig.config.webserver;
    } else {
      let contractsFolder = normalizePath(embarkConfig.config, true);
      if (contractsFolder.charAt(contractsFolder.length - 1) !== '/') {
        contractsFolder += '/';
      }
      webserverConfig = [`${contractsFolder}**/webserver.json`, `${contractsFolder}**/webserver.js`];
    }
    this.watchFiles(webserverConfig,
      function (eventName, path) {
        self.logger.info(`${eventName}: ${path}`);
        self.events.emit('webserver:config:change', 'config', path);
      },
      function () {
        callback();
      }
    );
  }

  watchContractConfig(embarkConfig, callback) {
    let self = this;
    let contractConfig;
    if (typeof embarkConfig.config === 'object' || embarkConfig.config.contracts) {
      contractConfig = embarkConfig.config.contracts;
    } else {
      let contractsFolder = normalizePath(embarkConfig.config, true);
      if (contractsFolder.charAt(contractsFolder.length - 1) !== '/') {
        contractsFolder += '/';
      }
      contractConfig = [`${contractsFolder}**/contracts.json`, `${contractsFolder}**/contracts.js`];
    }
    this.watchFiles(contractConfig,
      function (eventName, path) {
        self.logger.info(`${eventName}: ${path}`);
        self.events.emit('file-' + eventName, 'config', path);
        self.events.emit('file-event', {fileType: 'config', path});
      },
      function () {
        callback();
      }
    );
  }

  watchPipelineConfig(embarkConfig, callback) {
    let filesToWatch = [
      dappPath('', DAPP_WEBPACK_CONFIG_FILE),
      dappPath('', DAPP_BABEL_LOADER_OVERRIDES_CONFIG_FILE)
    ];

    if (typeof embarkConfig.config === 'object' && embarkConfig.config.pipeline) {
      filesToWatch.push(embarkConfig.config.pipeline);
    } else if (typeof embarkConfig.config === 'string') {
      filesToWatch.push(dappPath(embarkConfig.config, DAPP_PIPELINE_CONFIG_FILE));
    }

    this.watchFiles(filesToWatch, (eventName, path) => {
      this.logger.info(`${eventName}: ${path}`);
      this.events.emit('file-' + eventName, 'config', path);
      this.events.emit('file-event', {fileType: 'config', path});
    }, callback);
  }

  watchFiles(files, changeCallback, doneCallback) {
    this.logger.trace('watchFiles');
    this.logger.trace(files);

    let configWatcher = chokidar.watch(files, {
      ignored: /[\/\\]\.|tmp_/, persistent: true, ignoreInitial: true, followSymlinks: true
    });
    this.fileWatchers.push(configWatcher);

    configWatcher
      .on('add', path => changeCallback('add', path))
      .on('change', path => changeCallback('change', path))
      .on('unlink', path => changeCallback('remove', path))
      .once('ready', () => {
        configWatcher.isReady = true;
        if (configWatcher.shouldClose) configWatcher.close();
        doneCallback();
      });
  }

}

module.exports = Watcher;

