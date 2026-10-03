{
	"name": "run_cmd",
	"description": "Runs a shell command",
	"arguments": [
		{
			"type": "string",
			"name": "command",
			"description": "The shell command to run",
			"disallow": ["sh", "bash", "zsh", "ash", "fish", "powershell"]
		}
	]
}¤

return(call(main))

fn main with () do
return(call(run_shell, args.command))
close

fn run_shell with (command: string) do
set var result to nodejs.child_process.run(command)
return(result)
close
