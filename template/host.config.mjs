// Host configuration for {{PROJECT_NAME}}.
// See host/config.mjs for the full list of options.
export default {
  name: '{{PROJECT_NAME}}',
  description: 'A Fleet agent built with the workflow kit.',

  fleet: {},

  comm: {
    adapter: 'express',
  },
};
