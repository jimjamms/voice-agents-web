"""Run with python3 verification/memory50_desktop_test.py; uses temporary SQLite only."""
import ast
import importlib.util
import tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('travel_state', root/'lib/Shifts-and-Giggles/travel_state.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    state = module.TravelState(Path(directory)/'state.sqlite3')
    for mode, agent, bucket in [('shared','sage','shared'),('isolated','sage','sage'),('isolated','astra','astra')]:
        for index in range(55):
            state.remember('test-person',agent,mode,f'Preference record {index:03d}')
        entries=state.get('test-person')['payload']['memories'][bucket]
        assert len(entries)==50
        fact=lambda entry: entry if isinstance(entry,str) else entry['fact']
        assert fact(entries[0])=='Preference record 005'
        assert fact(entries[-1])=='Preference record 054'
        context=state.context('test-person',agent,mode)
        assert 'Preference record 005' in context and 'Preference record 054' in context
base=ast.parse((root/'lib/Shifts-and-Giggles/agent_base.py').read_text())
assignment=next(node for node in base.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='MAX_MEMORIES_PER_SPEAKER' for target in node.targets))
assert ast.literal_eval(assignment.value)==50
print('Desktop memory retention/context: 50 records in all three compartments passed.')
