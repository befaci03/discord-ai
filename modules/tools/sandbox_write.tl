{
	"name": "sandbox_write",
	"description": "Write or append a text file inside the sandboxed workspace. Refuses to overwrite.",
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
			"description": "If true, append to the file instead of creating it",
			"disallow": []
		}
	]
}¤

if args.append then
call(fs.append, args.path, args.content)
return("appended {1} bytes to {2}".format([args.content.length(), args.path]))
close
call(fs.write, args.path, args.content)
return("wrote {1} bytes to {2}".format([args.content.length(), args.path]))
