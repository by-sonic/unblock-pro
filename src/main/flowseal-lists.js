'use strict';

const snapshot = require('./flowseal-lists.snapshot.json');

// The application and packaged list generator use the same audited upstream data.
module.exports = {
  HOST_LIST_GENERAL: snapshot.lists['list-general.txt'].join('\n'),
  HOST_LIST_GOOGLE: snapshot.lists['list-google.txt'].join('\n'),
  HOST_LIST_EXCLUDE: snapshot.lists['list-exclude.txt'].join('\n'),
  snapshot
};
