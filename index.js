/* jshint node: true */

var fs        = require('fs');
var path      = require('path');
var denodeify = require('rsvp').denodeify;
var readFile  = denodeify(fs.readFile);
var consul    = require('consul');

var Promise   = require('ember-cli/lib/ext/promise');

var BasePlugin = require('ember-cli-deploy-plugin');

module.exports = {
  name: 'ember-cli-deploy-consul-kv-index',

  createDeployPlugin: function(options) {
    var Plugin = BasePlugin.extend({
      name: options.name,

      defaultConfig: {
        secure: true,
        host: 'localhost',
        port: 8500,
        filePattern: 'index.html',
        allowOverwrite: false,
        maxEntries: 5,
        distDir: function(context) {
          return context.distDir || 'tmp/deploy-dist';
        },
        namespace: function(context) {
          return context.project.name();
        },
        revisionKey: function(context) {
          return (context.revisionData && context.revisionData.revisionKey) || 'missing-revision-key';
        },
        revisionKeyToActivate: function(context) {
          return context.commandOptions.revision;
        },
        metadata: function(context) {
          return context.revisionData || {};
        },
        consulClient: function(context) {
          return context.consulClient.kv;
        }
      },

      setup: function() {
        var host   = this.readConfig('host');
        var port   = this.readConfig('port');
        var secure = this.readConfig('secure');

        var client = consul({
          host: host,
          port: port,
          secure: secure,
          promisify: true
        });

        return { consulClient: client };
      },

      upload: function() {
        var allowOverwrite = this.readConfig('allowOverwrite');
        var maxEntries     = this.readConfig('maxEntries');
        var namespace      = this.readConfig('namespace');
        var revisionKey    = this.readConfig('revisionKey');
        var metadata       = this.readConfig('metadata');

        var distDir     = this.readConfig('distDir');
        var filePattern = this.readConfig('filePattern');
        var filePath    = path.join(distDir, filePattern);

        this.log('Uploading `' + filePath + '`', { verbose: true });

        return this._determineIfShouldUpload(namespace, revisionKey, allowOverwrite)
          .then(this._readFileContents.bind(this, filePath))
          .then(this._upload.bind(this, namespace, revisionKey))
          .then(this._uploadMetadata.bind(this, namespace, revisionKey, metadata))
          .then(this._updateRecentRevisions.bind(this, namespace, revisionKey))
          .then(this._trimRecentRevisions.bind(this, namespace, maxEntries))
          .then(this._uploadSuccess.bind(this, namespace, revisionKey));
      },

      activate: function() {
        var namespace   = this.readConfig('namespace');
        var revisionKey = this.readConfig('revisionKeyToActivate');

        this.log('Activating revision `' + revisionKey + '` in namespace `' + namespace + '`', { verbose: true });

        return this._retrieveRecentRevisions(namespace)
          .then(this._validateRevisionKey.bind(this, revisionKey))
          .then(this._activateRevision.bind(this, namespace, revisionKey))
          .then(this._activationSuccess.bind(this, namespace, revisionKey));
      },

      _determineIfShouldUpload: function(namespace, revisionKey, shouldOverwrite) {
        var consul = this.readConfig('consulClient');
        var key    = namespace + '/revisions/' + revisionKey;

        return consul.keys(key)
          .then(function(result) {
            if (result.indexOf(key) === -1 || shouldOverwrite) {
              return Promise.resolve();
            }

            return Promise.reject('Revision already exists');
          }, function() {
            return Promise.resolve(); // revision doesn't already exist
          });
      },

      _readFileContents: function(path) {
        return readFile(path)
          .then(function(buffer) {
            return Promise.resolve(buffer.toString());
          });
      },

      _upload: function(namespace, revisionKey, data) {
        var consul = this.readConfig('consulClient');
        var key    = namespace + '/revisions/' + revisionKey;

        return consul.set(key, data);
      },

      _uploadMetadata: function(namespace, revisionKey, metadata) {
        var consul = this.readConfig('consulClient');
        var key    = namespace + '/revisions/' + revisionKey + '/metadata';

        return consul.set(key, JSON.stringify(metadata));
      },

      _updateRecentRevisions: function(namespace, revisionKey) {
        var consul = this.readConfig('consulClient');
        var key    = namespace + '/recent-revisions';

        return consul.get(key)
          .then(function(result) {
            if (!result) {
              return consul.set(key, revisionKey);
            } else {
              var revisionKeys = result['Value'].split(',');

              if (revisionKeys.indexOf(revisionKey) === -1) {
                revisionKeys.unshift(revisionKey);

                return consul.set(key, revisionKeys.join(','));
              }
            }

            return Promise.resolve();
          }, function() {
            return Promise.reject('Error occurred updating recent revisions');
          });
      },

      _trimRecentRevisions: function(namespace, maxEntries) {
        var consul = this.readConfig('consulClient');
        var key    = namespace + '/recent-revisions';

        return consul.get(key)
          .then(function(result) {
            var revisionKeys = result['Value'].split(',');
            var remaining = revisionKeys.splice(0, maxEntries);

            if (revisionKeys.length) {
              return consul.set(key, remaining.join(','))
                .then(function() {
                  if (revisionKeys.length > 0) {
                    return Promise.all(revisionKeys.map(function(revisionKey) {
                      var key = namespace + '/revisions/' + revisionKey;
                      return consul.del({ key: key, recurse: true });
                    }, []));
                  } else {
                    return Promise.resolve();
                  }
                });
            } else {
              return Promise.resolve();
            }
          });
      },

      _uploadSuccess: function(namespace, revisionKey) {
        this.log('Uploaded with key `' + revisionKey + '` into namespace `' + namespace + '`', { verbose: true });
        return Promise.resolve();
      },

      _retrieveRecentRevisions: function(namespace) {
        var consul = this.readConfig('consulClient');
        var key = namespace + '/recent-revisions';

        return consul.get(key)
          .then(function(result) {
            if (result) {
              var revisionKeys = result['Value'].split(',');

              if (revisionKeys.length) {
                return revisionKeys;
              } else {
                return Promise.reject('No recent revisions found');
              }
            } else {
              return Promise.reject('No recent revisions found');
            }
          });
      },

      _validateRevisionKey: function(revisionKey, recentRevisions) {
        if (recentRevisions.indexOf(revisionKey) > -1) {
          return Promise.resolve();
        } else {
          return Promise.reject('Unknown revision key');
        }
      },

      _activateRevision: function(namespace, revisionKey) {
        var consul = this.readConfig('consulClient');
        var key    = namespace + '/active-revision';

        return consul.set(key, revisionKey);
      },

      _activationSuccess: function(namespace, revisionKey) {
        this.log('✔ Activated revision `' + revisionKey + '` in namespace `' + namespace + '`', { verbose: true });

        return Promise.resolve();
      }
    });

    return new Plugin();
  }
};
