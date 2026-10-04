{
	"name": "sandbox_write",
	"description": "Write, append or overwrite a text file inside the sandboxed workspace. Existing files are protected: pass overwrite=true to replace one, append=true to add to it.",
	"arguments": [
		{
			"type": "string",
			"name": "path",
			"description": "Relative path inside the sandbox (e.g. 'notes/todo.txt')",
			"disallow": ["..", "~", "/etc", "/root"]
		},
		{
			"type": "string",
			"name": "content",
			"description": "The text content to write",
			"disallow": []
		},
		{
			"type": "boolean",
			"name": "append",
			"description": "If true, append to the file instead of writing (omit for false)",
			"disallow": [],
			"optional": true
		},
		{
			"type": "boolean",
			"name": "overwrite",
			"description": "If true, replace the file when it already exists (omit for false; ignored when append=true)",
			"disallow": [],
			"optional": true
		}
	]
}¤

if args.append then
call(fs.append, args.path, args.content)
return("appended {1} bytes to {2}".format([args.content.length(), args.path]))
close
call(fs.write, args.path, args.content, args.overwrite)
return("wrote {1} bytes to {2}".format([args.content.length(), args.path]))
