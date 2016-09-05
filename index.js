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
        host: 'localhost',
        port: 8500,
        secure: true,
        filePattern: 'index.html',
        distDir: function(context) {
          return context.distDir || 'tmp/deploy-dist';
        },
        revisionKey: function(context) {
          return (context.revisionData && context.revisionData.revisionKey) || 'missing-revision-key';
        },
        namespaceToken: function(context) {
          return (context.project && context.project.name()) || 'missing-namespace';
        },
        recentRevisionsToken: 'recent-revisions',
        activeRevisionToken: 'active-revision',
        revisionKeyToActivate: function(context) {
          return (context.commandOptions && context.commandOptions.revision);
        },
        metadata: function(context) {
          return context.revisionData || {};
        },
        allowOverwrite: true,
        maxRevisions: 10,
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
        var maxRevisions   = this.readConfig('maxRevisions');
        var namespace      = this.readConfig('namespaceToken');
        var revisionKey    = this.readConfig('revisionKey');
        var metadata       = this.readConfig('metadata');

        var distDir     = this.readConfig('distDir');
        var filePattern = this.readConfig('filePattern');
        var filePath    = path.join(distDir, filePattern);

        this.log('Uploading `' + filePath + '`', { verbose: true });

        return this._determineIfShouldUpload(namespace, revisionKey, allowOverwrite)
          .then(this._readFileContents.bind(this, filePath))
          .then(this._uploadRevision.bind(this, namespace, revisionKey))
          .then(this._uploadMetadata.bind(this, namespace, revisionKey, metadata))
          .then(this._updateRecentRevisions.bind(this, namespace, revisionKey))
          .then(this._trimRecentRevisions.bind(this, namespace, maxRevisions))
          .then(this._uploadSuccess.bind(this, namespace, revisionKey));
      },

      activate: function() {
        var namespace   = this.readConfig('namespaceToken');
        var revisionKey = this.readConfig('revisionKeyToActivate');

        this.log('Activating revision `' + revisionKey + '` in namespace `' + namespace + '`', { verbose: true });

        return this._recentRevisionKeys(namespace)
          .then(this._validateRevisionKey.bind(this, revisionKey))
          .then(this._activateRevision.bind(this, namespace, revisionKey))
          .then(this._activationSuccess.bind(this, namespace, revisionKey));
      },

      fetchRevisions: function() {
        var namespace = this.readConfig('namespaceToken');

        return Promise.hash({
            revisions: this._recentRevisionKeys(namespace),
            activeRevision: this._activeRevisionKey(namespace)
          })
          .then(function(result) {
            return result.revisions.map(function(revisionKey) {
              return {
                revision: revisionKey,
                active: revisionKey === result.activeRevision
              };
            });
          })
        .then(function(revisions) {
          return {
            revisions: revisions
          };
        });
      },

      _determineIfShouldUpload: function(namespace, revisionKey, shouldOverwrite) {
        var key = namespace + '/revisions/' + revisionKey;

        function checkForRevisionKey(keys) {
          if (!keys || keys.indexOf(key) === -1 || shouldOverwrite) {
            return Promise.resolve();
          }

          return Promise.reject('Revision already exists');
        }

        function handleNoKeys() {
          return Promise.resolve();
        }

        return this._keys(key)
          .then(checkForRevisionKey.bind(this), handleNoKeys.bind(this));
      },

      _readFileContents: function(path) {
        return readFile(path)
          .then(function(buffer) {
            return Promise.resolve(buffer.toString());
          }, function() {
            return Promise.reject('No file found at `' + path + '`');
          });
      },

      _uploadRevision: function(namespace, revisionKey, data) {
        return this._setRevision(namespace, revisionKey, data);
      },

      _uploadMetadata: function(namespace, revisionKey, metadata) {
        return this._setRevisionMetadata(namespace, revisionKey, metadata);
      },

      _updateRecentRevisions: function(namespace, revisionKey) {
        var self = this;

        return this._recentRevisionKeys(namespace)
          .then(function(revisionKeys) {
            if (revisionKeys.indexOf(revisionKey) === -1) {
              revisionKeys.unshift(revisionKey);

            }

            return self._setRecentRevisions(namespace, revisionKeys.join(','));
          });
      },

      _trimRecentRevisions: function(namespace, maxRevisions) {
        var self = this;

        return this._recentRevisionKeys(namespace)
          .then(function(revisionKeys) {
            if (!revisionKeys.length || revisionKeys.length <= maxRevisions) {
              return Promise.resolve();
            }

            var remaining = revisionKeys.splice(0, maxRevisions);

            return self._setRecentRevisions(namespace, remaining.join(','))
              .then(function() {
                  return Promise.all(revisionKeys.map(function(revisionKey) {
                    return self._deleteRevision(namespace, revisionKey);
                  }, []));
              });
          });
      },

      _uploadSuccess: function(namespace, revisionKey) {
        this.log('Uploaded with key `' + revisionKey + '` into namespace `' + namespace + '`', { verbose: true });
        return Promise.resolve();
      },

      _validateRevisionKey: function(revisionKey, recentRevisions) {
        if (!revisionKey) {
          return Promise.reject('Revision key to activate must be provided');
        }

        if (recentRevisions.indexOf(revisionKey) > -1) {
          return Promise.resolve();
        } else {
          return Promise.reject('Unknown revision key');
        }
      },

      _activateRevision: function(namespace, revisionKey) {
        return this._setActiveRevision(namespace, revisionKey);
      },

      _activationSuccess: function(namespace, revisionKey) {
        this.log('✔ Activated revision `' + revisionKey + '` in namespace `' + namespace + '`', { verbose: true });

        return Promise.resolve();
      },

      _activeRevisionKey: function(namespace) {
        return this._getActiveRevision(namespace);
      },

      _recentRevisionKeys: function(namespace) {
        return this._getRecentRevisions(namespace)
          .then(function(result) {
            var value = (result && result.split(',')) || [];

            return Promise.resolve(value);
          });
      },

      _getRecentRevisions: function(namespace) {
        var recentRevisions = this.readConfig('recentRevisionsToken');
        var key = namespace + '/' + recentRevisions;

        return this._get(key);
      },

      _setRecentRevisions: function(namespace, value) {
        var recentRevisions = this.readConfig('recentRevisionsToken');
        var key = namespace + '/' + recentRevisions;

        return this._set(key, value);
      },

      _setRevision: function(namespace, revisionKey, value) {
        var key = namespace + '/revisions/' + revisionKey;

        return this._set(key, value);
      },

      _deleteRevision: function(namespace, revisionKey) {
        var key = namespace + '/revisions/' + revisionKey;
        return this._delete({ key: key, recurse: true });
      },

      _setRevisionMetadata: function(namespace, revisionKey, value) {
        var key = namespace + '/revisions/' + revisionKey + '/metadata';

        return this._set(key, JSON.stringify(value));
      },

      _setActiveRevision: function(namespace, revisionKey) {
        var activeRevision = this.readConfig('activeRevisionToken');
        var key = namespace + '/' + activeRevision;

        return this._set(key, revisionKey);
      },

      _getActiveRevision: function(namespace) {
        var activeRevision = this.readConfig('activeRevisionToken');
        var key = namespace + '/' + activeRevision;

        return this._get(key);
      },

      _keys: function(key) {
        var consul = this.readConfig('consulClient');

        return consul.keys(key);
      },

      _get: function(key) {
        var consul = this.readConfig('consulClient');

        return consul.get(key)
          .then(function(result) {
            var value = (result && result['Value']) || null;

            return Promise.resolve(value);
          });
      },

      _set: function(key, value) {
        var consul = this.readConfig('consulClient');

        return consul.set(key, value);
      },

      _delete: function(options) {
        var consul = this.readConfig('consulClient');

        return consul.del(options);
      }
    });

    return new Plugin();
  }
};
