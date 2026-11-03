"""Strata's public analysis API. Consumers should import from core."""
from .scan import Repository, analyze, check, compare_imports, load_config, scan
from .boundaries import read_boundaries, preview_boundaries, save_boundaries
from .change_history import history_evidence
from .gate_graph import gate_evidence

__all__ = ['Repository', 'analyze', 'check', 'compare_imports', 'load_config', 'scan',
           'read_boundaries', 'preview_boundaries', 'save_boundaries', 'history_evidence', 'gate_evidence']
