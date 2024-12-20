export default {
	tags: [
		"posts"
	],
	"permalink": "/posts/{{ date | permalinkDate }}-{{ title | slug }}/index.html",
	"layout": "layouts/post.njk",
};
