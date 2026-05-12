module.exports.start = function start(ctx) {
  ctx.ui.addSidebarPage({
    id: "page",
    label: ctx.plugin.name,
    title: ctx.plugin.name,
    render() {
      return `
        <p>${ctx.plugin.name} is running as a UnifyHub runtime plugin.</p>
        <p>Edit <code>runtime/renderer.js</code> to build your page.</p>
      `;
    }
  });

  ctx.log("renderer runtime loaded");
};
